/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from "fs";
import path from "path";

import { isUnderTest } from "../utils/debug";
import { mime } from "../../utilsBundle";
import { syncLocalStorageWithSettings } from "../launchApp";
import { launchApp } from "../launchApp";
import { ProgressController } from "../progress";
import { ThrottledFile } from "./throttledFile";
import { languageSet } from "../codegen/languages";
import { collapseActions, shouldMergeAction } from "./recorderUtils";
import { generateCode } from "../codegen/language";
import { Recorder, RecorderEvent } from "../recorder";
import { BrowserContext } from "../browserContext";
import { performAction } from "./recorderRunner";

import type { Page } from "../page";
import type { Frame } from "../frames";
import type * as actions from "@recorder/actions";
import type {
  CallLog,
  ElementInfo,
  Mode,
  Source,
  PerformActionParams,
  PerformExtractionParams,
  ExecuteArbitraryCodeParams,
} from "@recorder/recorderTypes";
import type { Language, LanguageGeneratorOptions } from "../codegen/types";
import type * as channels from "@protocol/channels";

export type RecorderAppParams = channels.BrowserContextEnableRecorderParams & {
  browserName: string;
  sdkLanguage: Language;
  headed: boolean;
  executablePath?: string;
  channel?: string;
};

export class RecorderApp {
  private _recorder: Recorder;
  private _page: Page;
  readonly wsEndpointForTest: string | undefined;
  private _languageGeneratorOptions: LanguageGeneratorOptions;
  private _throttledOutputFile: ThrottledFile | null = null;
  private _actions: actions.ActionInContext[] = [];
  private _userSources: Source[] = [];
  private _recorderSources: Source[] = [];
  private _primaryGeneratorId: string;
  private _selectedGeneratorId: string;

  private constructor(
    recorder: Recorder,
    params: RecorderAppParams,
    page: Page,
    wsEndpointForTest: string | undefined
  ) {
    this._page = page;
    this._recorder = recorder;
    this.wsEndpointForTest = wsEndpointForTest;

    // Make a copy of options to modify them later.
    this._languageGeneratorOptions = {
      browserName: params.browserName,
      launchOptions: {
        headless: false,
        ...params.launchOptions,
        tracesDir: undefined,
      },
      contextOptions: { ...params.contextOptions },
      deviceName: params.device,
      saveStorage: params.saveStorage,
    };

    this._throttledOutputFile = params.outputFile
      ? new ThrottledFile(params.outputFile)
      : null;
    this._primaryGeneratorId =
      process.env.TEST_INSPECTOR_LANGUAGE ||
      params.language ||
      determinePrimaryGeneratorId(params.sdkLanguage);
    this._selectedGeneratorId = this._primaryGeneratorId;
  }

  private async _init(inspectedContext: BrowserContext) {
    await syncLocalStorageWithSettings(this._page, "recorder");

    const controller = new ProgressController();
    await controller.run(async (progress) => {
      await this._page.addRequestInterceptor(progress, (route) => {
        if (!route.request().url().startsWith("https://playwright/")) {
          route.continue({ isFallback: true }).catch(() => {});
          return;
        }

        const uri = route
          .request()
          .url()
          .substring("https://playwright/".length);
        const file = require.resolve("../../vite/recorder/" + uri);
        fs.promises.readFile(file).then((buffer) => {
          route
            .fulfill({
              status: 200,
              headers: [
                {
                  name: "Content-Type",
                  value:
                    mime.getType(path.extname(file)) ||
                    "application/octet-stream",
                },
              ],
              body: buffer.toString("base64"),
              isBase64: true,
            })
            .catch(() => {});
        });
      });

      await this._page.exposeBinding(
        progress,
        "dispatch",
        false,
        (_, data: any) => this._handleUIEvent(data)
      );

      this._page.once("close", () => {
        this._recorder.close();
        this._page.browserContext
          .close({ reason: "Recorder window closed" })
          .catch(() => {});
        delete (inspectedContext as any)[recorderAppSymbol];
      });

      await this._page
        .mainFrame()
        .goto(
          progress,
          process.env.PW_HMR
            ? "http://localhost:44225"
            : "https://playwright/index.html"
        );
    });

    const url = this._recorder.url();
    if (url) this._onPageNavigated(url);
    this._onModeChanged(this._recorder.mode());
    this._onPausedStateChanged(this._recorder.paused());
    this._updateActions("reveal");
    // Update paused sources *after* generated ones, to reveal the currently paused source if any.
    this._onUserSourcesChanged(
      this._recorder.userSources(),
      this._recorder.pausedSourceId()
    );
    this._onCallLogsUpdated(this._recorder.callLog());
    this._wireListeners(this._recorder);
  }

  private _handleUIEvent(data: any) {
    if (data.event === "clear") {
      this._actions = [];
      this._updateActions("reveal");
      this._recorder.clear();
      return;
    }
    if (data.event === "fileChanged") {
      const source = [...this._recorderSources, ...this._userSources].find(
        (s) => s.id === data.params.fileId
      );
      if (source) {
        if (source.isRecorded) this._selectedGeneratorId = source.id;
        this._recorder.setLanguage(source.language);
      }
      return;
    }
    if (data.event === "setAutoExpect") {
      this._languageGeneratorOptions.generateAutoExpect =
        data.params.autoExpect;
      this._updateActions();
      return;
    }
    if (data.event === "setMode") {
      this._recorder.setMode(data.params.mode);
      return;
    }
    if (data.event === "resume") {
      this._recorder.resume();
      return;
    }
    if (data.event === "pause") {
      this._recorder.pause();
      return;
    }
    if (data.event === "step") {
      this._recorder.step();
      return;
    }
    if (data.event === "highlightRequested") {
      if (data.params.selector)
        this._recorder.setHighlightedSelector(data.params.selector);
      if (data.params.ariaTemplate)
        this._recorder.setHighlightedAriaTemplate(data.params.ariaTemplate);
      return;
    }
    if (data.event === "performAction") {
      void this._executeUIAction(data.params);
      return;
    }
    if (data.event === "performExtraction") {
      void this._executeUIExtraction(data.params);
      return;
    }
    if (data.event === "executeArbitraryCode") {
      this._executeArbitraryCode(data.params).catch(err => {
        console.error('Failed to execute arbitrary code:', err);
        // Don't re-throw to prevent crashing the entire recorder
      });
      return;
    }
    throw new Error(`Unknown event: ${data.event}`);
  }

  private async _executeUIAction(params: PerformActionParams) {
    const { locator, action, args = [] } = params;

    // Validation
    if (!locator?.trim()) throw new Error("Locator is required");

    try {
      // 1. Resolve target frame/page
      const pageAliases = this._recorder.pageAliases();
      if (pageAliases.size === 0)
        throw new Error("No pages available for action execution");

      const frame = this._recorder.frameForSelector(locator);

      // 2. Build synthetic ActionInContext
      const actionObject = this._buildSyntheticAction(locator, action, args);
      const frameDescription: actions.FrameDescription = {
        pageGuid: frame._page.guid,
        pageAlias: pageAliases.get(frame._page) || "page",
        framePath: [],
      };
      const actionInContext: actions.ActionInContext = {
        frame: frameDescription,
        action: actionObject,
        startTime: Date.now(),
      };

      // 3. Log: push to call log as 'in-progress'
      const callLogId = this._recorder.pushTemporaryCallLog(actionInContext);

      try {
        await performAction(pageAliases, actionInContext);
        this._recorder.updateTemporaryCallLog(callLogId, "done");
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this._recorder.updateTemporaryCallLog(callLogId, "error", errorMessage);
        throw e; // Re-throw so the UI can show the error
      }
    } catch (error) {
      throw error; // Re-throw so it can be caught by the caller
    }
  }

  private _buildSyntheticAction(
    selector: string,
    actionName: string,
    args: any[]
  ): actions.Action {
    const baseFields = {
      signals: [] as actions.Signal[],
      selector,
    };

    switch (actionName) {
      case "click":
        return {
          ...baseFields,
          name: "click",
          modifiers: 0,
          button: "left",
          clickCount: 1,
        } as actions.ClickAction;
      case "dblclick":
        return {
          ...baseFields,
          name: "click",
          modifiers: 0,
          button: "left",
          clickCount: 2,
        } as actions.ClickAction;
      case "fill":
        return {
          ...baseFields,
          name: "fill",
          text: args[0] || "",
        } as actions.FillAction;
      case "press":
        return {
          ...baseFields,
          name: "press",
          key: args[0] || "Enter",
          modifiers: 0,
        } as actions.PressAction;
      case "check":
        return {
          ...baseFields,
          name: "check",
        } as actions.CheckAction;
      case "uncheck":
        return {
          ...baseFields,
          name: "uncheck",
        } as actions.UncheckAction;
      case "selectOption":
        return {
          ...baseFields,
          name: "select",
          options: args[0] ? [args[0]] : [],
        } as actions.SelectAction;
      default:
        throw new Error(`Unsupported action: ${actionName}`);
    }
  }

  private async _executeUIExtraction(params: PerformExtractionParams) {
    const { locator, extraction, args = [] } = params;

    // Validation
    if (!locator?.trim()) throw new Error("Locator is required");

    try {
      // 1. Resolve target frame
      const frame = this._recorder.frameForSelector(locator);

      // 2. Log: push extraction to call log as 'in-progress'
      const frameDescription: actions.FrameDescription = {
        pageGuid: frame._page.guid,
        pageAlias: "page",
        framePath: [],
      };
      const callLogId = this._recorder.pushTemporaryCallLog({
        frame: frameDescription,
        action: {
          name: `extract_${extraction}`,
          selector: locator,
          args,
          signals: [],
        },
        startTime: Date.now(),
      });

      try {
        const result = await this._performExtraction(
          frame,
          locator,
          extraction,
          args
        );
        this._recorder.updateTemporaryCallLog(callLogId, "done", result);

        // Send result back to UI
        this._sendExtractionResultToUI(result, extraction);
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this._recorder.updateTemporaryCallLog(callLogId, "error", errorMessage);
        throw e; // Re-throw so the UI can show the error
      }
    } catch (error) {
      throw error; // Re-throw so it can be caught by the caller
    }
  }

  private async _performExtraction(
    frame: Frame,
    selector: string,
    extraction: string,
    args?: any[]
  ): Promise<any> {
    // Use frame methods directly like the performAction does
    const controller = new ProgressController();
    return await controller.run(async (progress) => {
      switch (extraction) {
        case "innerText":
          return await frame.innerText(progress, selector, { strict: true });
        case "textContent":
          return await frame.textContent(progress, selector, { strict: true });
        case "getAttribute":
          return await frame.getAttribute(progress, selector, args?.[0] || "", {
            strict: true,
          });
        case "isVisible":
          return await frame.isVisible(progress, selector, { strict: true });
        case "isEnabled":
          return await frame.isEnabled(progress, selector, { strict: true });
        case "isChecked":
          return await frame.isChecked(progress, selector, { strict: true });
        case "count":
          return await frame.locatorCount(progress, selector);
        case "boundingBox":
          return await frame.elementBoundingBox(progress, selector, { strict: true });
        default:
          throw new Error(`Unsupported extraction: ${extraction}`);
      }
    }, 5000);
  }

  private async _executeArbitraryCode(params: ExecuteArbitraryCodeParams) {
    const { code } = params;

    try {
      // Validation
      if (!code?.trim()) {
        throw new Error("Code is required");
      }

      // Get the first available page
      const pageAliases = this._recorder.pageAliases();
      if (pageAliases.size === 0) {
        throw new Error("No pages available for code execution");
      }

      const pages = Array.from(pageAliases.keys());
      const page = pages[0]; // Use the first page
      const pageAlias = pageAliases.get(page) || "page";

      // Log: push to call log as 'in-progress'
      const frameDescription: actions.FrameDescription = {
        pageGuid: page.guid,
        pageAlias,
        framePath: [],
      };
      const callLogId = this._recorder.pushTemporaryCallLog({
        frame: frameDescription,
        action: {
          name: "execute_code",
          selector: "",
          args: [code],
          signals: [],
        },
        startTime: Date.now(),
      });

      try {
        // Execute the code directly on the page
        const result = await this._executePlaywrightCode(page, code);
        this._recorder.updateTemporaryCallLog(callLogId, "done", result);

        // Send result back to UI if it's not undefined
        if (result !== undefined) {
          const isExtraction = this._isExtractionCommand(code);
          this._sendExtractionResultToUI(result, isExtraction ? "extraction" : "action");
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this._recorder.updateTemporaryCallLog(callLogId, "error", errorMessage);
        throw e;
      }
    } catch (error) {
      throw error;
    }
  }

  private async _executePlaywrightCode(page: Page, code: string): Promise<any> {
    try {
      // Create a public API wrapper for the internal page
      const publicAPI = this._createPublicAPIWrapper(page);
      
      const func = new Function(
        "page", "locator", "getByRole", "getByText", "getByPlaceholder", "getByTestId",
        `
        return (async () => {
          return await ${code};
        })();
      `
      );

      const result = await func(
        publicAPI, 
        publicAPI.locator, 
        publicAPI.getByRole, 
        publicAPI.getByText, 
        publicAPI.getByPlaceholder, 
        publicAPI.getByTestId
      );
      return result;
    } catch (error) {
      throw new Error(
        `Failed to execute code "${code}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private _createPublicAPIWrapper(page: Page): any {
    // Create a wrapper that provides the public Playwright API
    return {
      // Locator creation methods
      locator: (selector: string) => this._createLocatorWrapper(page.mainFrame(), selector),
      getByRole: (role: string, options?: any) => {
        const roleSelector = this._buildRoleSelector(role, options);
        return this._createLocatorWrapper(page.mainFrame(), roleSelector);
      },
      getByText: (text: string | RegExp) => {
        const textSelector = this._buildTextSelector(text);
        return this._createLocatorWrapper(page.mainFrame(), textSelector);
      },
      getByPlaceholder: (placeholder: string) => {
        const placeholderSelector = `[placeholder*="${placeholder}"]`;
        return this._createLocatorWrapper(page.mainFrame(), placeholderSelector);
      },
      getByTestId: (testId: string) => {
        const testIdSelector = `[data-testid="${testId}"]`;
        return this._createLocatorWrapper(page.mainFrame(), testIdSelector);
      },
      // Direct page methods
      goto: (url: string) => page.mainFrame().goto(new ProgressController().run(p => p), url),
      title: () => page.title(),
      url: () => page.mainFrame().url(),
    };
  }

  private _createLocatorWrapper(frame: Frame, selector: string): any {
    const controller = new ProgressController();
    return {
      // Action methods
      click: async (options?: any) => {
        return await controller.run(async (progress) => {
          return await frame.click(progress, selector, { strict: true, ...options });
        }, 5000);
      },
      fill: async (text: string) => {
        return await controller.run(async (progress) => {
          return await frame.fill(progress, selector, text, { strict: true });
        }, 5000);
      },
      press: async (key: string) => {
        return await controller.run(async (progress) => {
          return await frame.press(progress, selector, key, { strict: true });
        }, 5000);
      },
      // Extraction methods
      innerText: async () => {
        return await controller.run(async (progress) => {
          return await frame.innerText(progress, selector, { strict: true });
        }, 5000);
      },
      textContent: async () => {
        return await controller.run(async (progress) => {
          return await frame.textContent(progress, selector, { strict: true });
        }, 5000);
      },
      isVisible: async () => {
        return await controller.run(async (progress) => {
          return await frame.isVisible(progress, selector, { strict: true });
        }, 5000);
      },
      isEnabled: async () => {
        return await controller.run(async (progress) => {
          return await frame.isEnabled(progress, selector, { strict: true });
        }, 5000);
      },
      isChecked: async () => {
        return await controller.run(async (progress) => {
          return await frame.isChecked(progress, selector, { strict: true });
        }, 5000);
      },
    };
  }

  private _buildRoleSelector(role: string, options?: any): string {
    let selector = `role=${role}`;
    if (options?.name) {
      const name = typeof options.name === 'string' ? options.name : String(options.name);
      selector += `[name="${name}"i]`;
    }
    return `internal:${selector}`;
  }

  private _buildTextSelector(text: string | RegExp): string {
    if (text instanceof RegExp) {
      return `internal:text=${text.source}`;
    }
    return `internal:text="${text}"i`;
  }

  static async show(
    context: BrowserContext,
    params: channels.BrowserContextEnableRecorderParams
  ) {
    if (process.env.PW_CODEGEN_NO_INSPECTOR) return;
    const recorder = await Recorder.forContext(context, params);
    if (params.recorderMode === "api") {
      const browserName = context._browser.options.name;
      await ProgrammaticRecorderApp.run(context, recorder, browserName, params);
      return;
    }
    await RecorderApp._show(recorder, context, params);
  }

  async close() {
    await this._page.close();
  }

  static showInspectorNoReply(context: BrowserContext) {
    if (process.env.PW_CODEGEN_NO_INSPECTOR) return;
    void Recorder.forContext(context, {})
      .then((recorder) => RecorderApp._show(recorder, context, {}))
      .catch(() => {});
  }

  private static async _show(
    recorder: Recorder,
    inspectedContext: BrowserContext,
    params: channels.BrowserContextEnableRecorderParams
  ) {
    if ((inspectedContext as any)[recorderAppSymbol]) return;
    (inspectedContext as any)[recorderAppSymbol] = true;
    const sdkLanguage = inspectedContext._browser.sdkLanguage();
    const headed = !!inspectedContext._browser.options.headful;
    const recorderPlaywright = (
      require("../playwright")
        .createPlaywright as typeof import("../playwright").createPlaywright
    )({ sdkLanguage: "javascript", isInternalPlaywright: true });
    const { context: appContext, page } = await launchApp(
      recorderPlaywright.chromium,
      {
        sdkLanguage,
        windowSize: { width: 600, height: 600 },
        windowPosition: { x: 1020, y: 10 },
        persistentContextOptions: {
          noDefaultViewport: true,
          headless:
            !!process.env.PWTEST_CLI_HEADLESS || (isUnderTest() && !headed),
          cdpPort: isUnderTest() ? 0 : undefined,
          handleSIGINT: params.handleSIGINT,
          executablePath: inspectedContext._browser.options.isChromium
            ? inspectedContext._browser.options.customExecutablePath
            : undefined,
          // Use the same channel as the inspected context to guarantee that the browser is installed.
          channel: inspectedContext._browser.options.isChromium
            ? inspectedContext._browser.options.channel
            : undefined,
        },
      }
    );
    const controller = new ProgressController();
    await controller.run(async (progress) => {
      await appContext._browser._defaultContext!._loadDefaultContextAsIs(
        progress
      );
    });

    const appParams = {
      browserName: inspectedContext._browser.options.name,
      sdkLanguage: inspectedContext._browser.sdkLanguage(),
      wsEndpointForTest: inspectedContext._browser.options.wsEndpoint,
      headed: !!inspectedContext._browser.options.headful,
      executablePath: inspectedContext._browser.options.isChromium
        ? inspectedContext._browser.options.customExecutablePath
        : undefined,
      channel: inspectedContext._browser.options.isChromium
        ? inspectedContext._browser.options.channel
        : undefined,
      ...params,
    };

    const recorderApp = new RecorderApp(
      recorder,
      appParams,
      page,
      appContext._browser.options.wsEndpoint
    );
    await recorderApp._init(inspectedContext);
    (inspectedContext as any).recorderAppForTest = recorderApp;
  }

  private _wireListeners(recorder: Recorder) {
    recorder.on(
      RecorderEvent.ActionAdded,
      (action: actions.ActionInContext) => {
        this._onActionAdded(action);
      }
    );

    recorder.on(
      RecorderEvent.SignalAdded,
      (signal: actions.SignalInContext) => {
        this._onSignalAdded(signal);
      }
    );

    recorder.on(RecorderEvent.PageNavigated, (url: string) => {
      this._onPageNavigated(url);
    });

    recorder.on(RecorderEvent.ContextClosed, () => {
      this._onContextClosed();
    });

    recorder.on(RecorderEvent.ModeChanged, (mode: Mode) => {
      this._onModeChanged(mode);
    });

    recorder.on(RecorderEvent.PausedStateChanged, (paused: boolean) => {
      this._onPausedStateChanged(paused);
    });

    recorder.on(
      RecorderEvent.UserSourcesChanged,
      (sources: Source[], pausedSourceId?: string) => {
        this._onUserSourcesChanged(sources, pausedSourceId);
      }
    );

    recorder.on(
      RecorderEvent.ElementPicked,
      (elementInfo: ElementInfo, userGesture?: boolean) => {
        this._onElementPicked(elementInfo, userGesture);
      }
    );

    recorder.on(RecorderEvent.CallLogsUpdated, (callLogs: CallLog[]) => {
      this._onCallLogsUpdated(callLogs);
    });
  }

  private _onActionAdded(action: actions.ActionInContext) {
    this._actions.push(action);
    this._updateActions("reveal");
  }

  private _onSignalAdded(signal: actions.SignalInContext) {
    const lastAction = this._actions.findLast(
      (a) => a.frame.pageGuid === signal.frame.pageGuid
    );
    if (lastAction) lastAction.action.signals.push(signal.signal);
    this._updateActions();
  }

  private _onPageNavigated(url: string) {
    this._page
      .mainFrame()
      .evaluateExpression(
        (({ url }: { url: string }) => {
          window.playwrightSetPageURL(url);
        }).toString(),
        { isFunction: true },
        { url }
      )
      .catch(() => {});
  }

  private _onContextClosed() {
    this._throttledOutputFile?.flush();
    this._page.browserContext
      .close({ reason: "Recorder window closed" })
      .catch(() => {});
  }

  private _onModeChanged(mode: Mode) {
    this._page
      .mainFrame()
      .evaluateExpression(
        ((mode: Mode) => {
          window.playwrightSetMode(mode);
        }).toString(),
        { isFunction: true },
        mode
      )
      .catch(() => {});
  }

  private _onPausedStateChanged(paused: boolean) {
    this._page
      .mainFrame()
      .evaluateExpression(
        ((paused: boolean) => {
          window.playwrightSetPaused(paused);
        }).toString(),
        { isFunction: true },
        paused
      )
      .catch(() => {});
  }

  private _onUserSourcesChanged(
    sources: Source[],
    pausedSourceId: string | undefined
  ) {
    if (!sources.length && !this._userSources.length) return;
    this._userSources = sources;
    this._pushAllSources();
    this._revealSource(pausedSourceId);
  }

  private _onElementPicked(elementInfo: ElementInfo, userGesture?: boolean) {
    if (userGesture) this._page.bringToFront();
    this._page
      .mainFrame()
      .evaluateExpression(
        ((param: { elementInfo: ElementInfo; userGesture?: boolean }) => {
          window.playwrightElementPicked(param.elementInfo, param.userGesture);
        }).toString(),
        { isFunction: true },
        { elementInfo, userGesture }
      )
      .catch(() => {});
  }

  private _onCallLogsUpdated(callLogs: CallLog[]) {
    this._page
      .mainFrame()
      .evaluateExpression(
        ((callLogs: CallLog[]) => {
          window.playwrightUpdateLogs(callLogs);
        }).toString(),
        { isFunction: true },
        callLogs
      )
      .catch(() => {});
  }

  private _sendExtractionResultToUI(result: any, extraction: string) {
    this._page
      .mainFrame()
      .evaluateExpression(
        ((params: { result: any, extraction: string }) => {
          if (window.playwrightExtractionResult)
            window.playwrightExtractionResult(params.result, params.extraction);
        }).toString(),
        { isFunction: true },
        { result, extraction }
      )
      .catch(() => {
        // Ignore errors - the UI might not be ready
      });
  }

  private _isExtractionCommand(code: string): boolean {
    const trimmedCode = code.trim();
    // Check for extraction methods that return values
    const extractionMethods = /\.(innerText|textContent|isVisible|isEnabled|isChecked|getAttribute|count|boundingBox)\s*\(\s*\)?\s*$/;
    const pageExtractionMethods = /^page\.(title|url)\s*\(\s*\)?\s*$/;
    
    return extractionMethods.test(trimmedCode) || pageExtractionMethods.test(trimmedCode);
  }

  private _pushAllSources() {
    const sources = [...this._userSources, ...this._recorderSources];
    this._page
      .mainFrame()
      .evaluateExpression(
        (({ sources }: { sources: Source[] }) => {
          window.playwrightSetSources(sources);
        }).toString(),
        { isFunction: true },
        { sources }
      )
      .catch(() => {});
  }

  private _revealSource(sourceId: string | undefined) {
    if (!sourceId) return;
    this._page
      .mainFrame()
      .evaluateExpression(
        (({ sourceId }: { sourceId: string }) => {
          window.playwrightSelectSource(sourceId);
        }).toString(),
        { isFunction: true },
        { sourceId }
      )
      .catch(() => {});
  }

  private _updateActions(reveal?: "reveal") {
    const recorderSources = [];
    const actions = collapseActions(this._actions);

    let revealSourceId: string | undefined;
    for (const languageGenerator of languageSet()) {
      const { header, footer, actionTexts, text } = generateCode(
        actions,
        languageGenerator,
        this._languageGeneratorOptions
      );
      const source: Source = {
        isRecorded: true,
        label: languageGenerator.name,
        group: languageGenerator.groupName,
        id: languageGenerator.id,
        text,
        header,
        footer,
        actions: actionTexts,
        language: languageGenerator.highlighter,
        highlight: [],
      };
      source.revealLine = text.split("\n").length - 1;
      recorderSources.push(source);
      if (languageGenerator.id === this._primaryGeneratorId)
        this._throttledOutputFile?.setContent(source.text);
      if (reveal === "reveal" && source.id === this._selectedGeneratorId)
        revealSourceId = source.id;
    }

    this._recorderSources = recorderSources;
    this._pushAllSources();
    this._revealSource(revealSourceId);
  }
}

// For example, if the SDK language is 'javascript', this returns 'playwright-test'.
function determinePrimaryGeneratorId(sdkLanguage: Language): string {
  for (const language of languageSet()) {
    if (language.highlighter === sdkLanguage) return language.id;
  }
  return sdkLanguage;
}

export class ProgrammaticRecorderApp {
  static async run(
    inspectedContext: BrowserContext,
    recorder: Recorder,
    browserName: string,
    params: channels.BrowserContextEnableRecorderParams
  ) {
    let lastAction: actions.ActionInContext | null = null;
    const languages = [...languageSet()];

    const languageGeneratorOptions = {
      browserName: browserName,
      launchOptions: {
        headless: false,
        ...params.launchOptions,
        tracesDir: undefined,
      },
      contextOptions: { ...params.contextOptions },
      deviceName: params.device,
      saveStorage: params.saveStorage,
    };
    const languageGenerator =
      languages.find((l) => l.id === params.language) ??
      languages.find((l) => l.id === "playwright-test")!;

    recorder.on(RecorderEvent.ActionAdded, (action) => {
      const page = findPageByGuid(inspectedContext, action.frame.pageGuid);
      if (!page) return;
      const { actionTexts } = generateCode(
        [action],
        languageGenerator,
        languageGeneratorOptions
      );
      if (!lastAction || !shouldMergeAction(action, lastAction))
        inspectedContext.emit(BrowserContext.Events.RecorderEvent, {
          event: "actionAdded",
          data: action,
          page,
          code: actionTexts.join("\n"),
        });
      else
        inspectedContext.emit(BrowserContext.Events.RecorderEvent, {
          event: "actionUpdated",
          data: action,
          page,
          code: actionTexts.join("\n"),
        });
      lastAction = action;
    });
    recorder.on(RecorderEvent.SignalAdded, (signal) => {
      const page = findPageByGuid(inspectedContext, signal.frame.pageGuid);
      inspectedContext.emit(BrowserContext.Events.RecorderEvent, {
        event: "signalAdded",
        data: signal,
        page,
        code: "",
      });
    });
  }
}

function findPageByGuid(context: BrowserContext, guid: string) {
  return context.pages().find((p) => p.guid === guid);
}

const recorderAppSymbol = Symbol("recorderApp");
