/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import type { Language } from '../../playwright-core/src/utils/isomorphic/locatorGenerators';
import type { AriaTemplateNode } from '@isomorphic/ariaSnapshot';

export type Point = { x: number; y: number };

export type Mode =
  | 'inspecting'
  | 'recording'
  | 'none'
  | 'assertingText'
  | 'recording-inspecting'
  | 'standby'
  | 'assertingVisibility'
  | 'assertingValue'
  | 'assertingSnapshot';

export type ElementInfo = {
  selector: string;
  ariaSnapshot: string;
  xpath?: string;
  css?: string;
};

export type EventData = {
  event:
    | 'clear'
    | 'resume'
    | 'step'
    | 'pause'
    | 'setMode'
    | 'highlightRequested'
    | 'languageChanged'
    | 'performAction'
    | 'performExtraction'
    | 'executeArbitraryCode';
  params: any;
};

export type PerformActionParams = {
  locator: string;
  action: 'click' | 'dblclick' | 'fill' | 'press' | 'check' | 'uncheck' | 'selectOption' | 'hover' | 'scroll';
  args?: any[];
};

export type PerformExtractionParams = {
  locator: string;
  extraction: 'innerText' | 'textContent' | 'getAttribute' | 'isVisible' | 'isEnabled' | 'isChecked' | 'count' | 'boundingBox';
  args?: any[];
};

export type ExecuteArbitraryCodeParams = {
  code: string;
};

export type OverlayState = {
  offsetX: number;
};

export type UIState = {
  mode: Mode;
  actionPoint?: Point;
  actionSelector?: string;
  ariaTemplate?: AriaTemplateNode;
  language: Language;
  testIdAttributeName: string;
  overlay: OverlayState;
};

export type CallLogStatus = 'in-progress' | 'done' | 'error' | 'paused';

export type CallLog = {
  id: string;
  title: string;
  messages: string[];
  status: CallLogStatus;
  error?: string;
  reveal?: boolean;
  duration?: number;
  params: {
    url?: string;
    selector?: string;
  };
};

export type SourceHighlight = {
  line: number;
  type: 'running' | 'paused' | 'error';
};

export type Source = {
  isRecorded: boolean;
  id: string;
  label: string;
  text: string;
  language: Language;
  highlight: SourceHighlight[];
  revealLine?: number;
  // used to group the language generators
  group?: string;
  header?: string;
  footer?: string;
  actions?: string[];
};

declare global {
  interface Window {
    playwrightSetMode: (mode: Mode) => void;
    playwrightSetPaused: (paused: boolean) => void;
    playwrightSetSources: (sources: Source[]) => void;
    playwrightSelectSource: (sourceId: string) => void;
    playwrightSetPageURL: (url: string | undefined) => void;
    playwrightSetOverlayVisible: (visible: boolean) => void;
    playwrightUpdateLogs: (callLogs: CallLog[]) => void;
    playwrightElementPicked: (elementInfo: ElementInfo, userGesture?: boolean) => void;
    playwrightExtractionResult: (result: any, extraction: string) => void;
    playwrightSourcesEchoForTest: Source[];
    dispatch(data: any): Promise<void>;
  }
}
