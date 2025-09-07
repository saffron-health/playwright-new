# Specification – "Arbitrary Code Execution" in Playwright Inspector

## 1. Goal

Enable users to execute **arbitrary Playwright code** directly from the existing "Locator" tab of the bottom pane in the Inspector UI. Users can type any valid Playwright expression (actions, extractions, locator chains) and execute them interactively against the live page.

The feature is **exploratory only** – it does NOT persist new code to the generated script, nor interfere with normal recording; it simply runs the arbitrary code against the live page, shows visual feedback, and logs the result. For extractions, the actual extracted values are displayed prominently in the UI.

## 2. UX / UI Design

### 2.1 Locator tab enhancements  
• Keep the single-line CodeMirror editor (`<CodeMirrorWrapper>`) with updated placeholder: **"Type Playwright code to execute"**
• Add a simple action bar to the right of the editor with only:  

    [ ▶ Run Code ]   (primary button to execute arbitrary code)

• **No dropdowns** - users type complete Playwright expressions directly
• Pressing ⏎ in the editor triggers code execution
• Supported syntax examples:
  - `locator("#button").click()`
  - `getByRole('button', { name: 'Submit' }).click()`
  - `getByText('Hello World').innerText()`
  - `page.title()`
  - `getByPlaceholder('Email').fill('test@example.com')`

### 2.2 Execution Results and Feedback
• **Actions** (click, fill, etc.):
  – Success → green toast ("Operation succeeded") and log entry
  – Failure → red toast with detailed error message and log entry flagged `error`
• **Extractions** (innerText, isVisible, etc.):
  – Success → blue toast with extracted value ("Result: 'Hello World'") and log entry with full value
  – Failure → red toast with error message
• While running, the operation line in call-log is marked `in-progress`

### 2.3 Result Value Display  
• Execution results appear in multiple places:  
  – **Toast notification** with truncated value (first 100 chars)  
  – **Call-Log entry** with full value and data type  
  – **Enhanced result panel** below locator editor with improved formatting
• **Result Panel Enhancements:**
  – Professional styling with VS Code theme integration
  – Card-like appearance with subtle shadows and rounded corners
  – Uppercase header with arrow indicator (`→ RESULT`)
  – Better typography with improved font sizing and spacing
  – Word-wrapping for long results with proper line breaks
  – Empty state handling (shows "undefined" for empty results)
• **Smart Result Clearing:**
  – Extraction results persist until an action is performed
  – Action commands automatically clear previous extraction results
  – Switching between extraction and action commands triggers appropriate clearing
  – Results are cleared immediately for actions (since they don't return meaningful values)
• Values are JSON-formatted for consistency with proper indentation

### 2.4 Call-Log integration  
All executed code appears at the top of the Call-Log with status transitions identical to recorded actions (`in-progress → done|error`, duration, etc.).  
• **Actions** show standard execution info with operation name "execute_code"
• **Extractions** show the extracted value with proper formatting
• **Errors** show detailed error messages to help debug issues

## 3. High-level Architecture

```
UI (react) ──window.dispatch({event:'executeArbitraryCode', params: {code}})──►
RecorderApp._handleUIEvent() ──► _executeArbitraryCode() ──► 
_executePlaywrightCode() with PublicAPI wrapper ➜ real browser frame
```

• **Frontend** emits: `executeArbitraryCode` event with `code` parameter containing the full Playwright expression
• **RecorderApp** (Node side) handles validation, execution context setup, API mapping, and logging  
• **Public API Wrapper** maps familiar Playwright API (`locator`, `getByRole`, etc.) to internal frame methods
• **Error Handling** prevents crashes and provides detailed error messages in console logs

## 4. Detailed Implementation

### 4.1 Shared Types (`recorderTypes.d.ts`)
• Extend `EventData.event` union with `'executeArbitraryCode'`.  
```typescript
| 'executeArbitraryCode';
```
• Define payload interface:
```typescript
// Arbitrary Code Execution
params: {
  code: string;               // "getByRole('button', { name: 'Submit' }).click()"
}
```

### 4.2 Supported API Surface
The implementation provides a **Public API Wrapper** that makes familiar Playwright methods available:

**Locator Creation:**
- `locator(selector)` - Create locator from any CSS/XPath selector
- `getByRole(role, options)` - Find elements by ARIA role
- `getByText(text)` - Find elements by text content  
- `getByPlaceholder(placeholder)` - Find inputs by placeholder
- `getByTestId(testId)` - Find elements by data-testid

**Locator Actions:**
- `click(options?)` - Click the element
- `fill(text)` - Fill input with text
- `press(key)` - Press keyboard key

**Locator Queries:**
- `innerText()` - Get visible text content
- `textContent()` - Get all text content
- `isVisible()` - Check if element is visible
- `isEnabled()` - Check if element is enabled  
- `isChecked()` - Check if checkbox/radio is checked

**Page Methods:**
- `page.goto(url)` - Navigate to URL
- `page.title()` - Get page title
- `page.url()` - Get current URL

### 4.3 Frontend (vite/recorder/recorder.tsx)
• Enhanced state: `locator` (the code to execute), `executionResult` (with type tracking and timestamp)
• Render simplified action bar:  
```typescript
<ToolbarButton 
  icon='play' 
  title='Run Code' 
  onClick={runOperation}
  disabled={!locator.trim()}
/>
```
• Enhanced `runOperation` with smart result clearing:
```typescript
const runOperation = async () => {
  if (!locator.trim()) return;
  
  // Detect if this is an extraction (returns a value) or action (performs an action)
  const isExtraction = /\.(innerText|textContent|isVisible|isEnabled|isChecked|getAttribute|count|boundingBox)\s*\(\s*\)?\s*$/.test(locator.trim()) || 
                       /^page\.(title|url)\s*\(\s*\)?\s*$/.test(locator.trim());
  
  // Clear previous result if switching between action and extraction
  if (executionResult && 
      ((executionResult.type === 'action' && isExtraction) || 
       (executionResult.type === 'extraction' && !isExtraction))) {
    setExecutionResult(null);
  }
  
  // For actions (non-extraction operations), clear the result immediately
  if (!isExtraction) {
    setExecutionResult(null);
  }
  
  try {
    await window.dispatch({
      event: 'executeArbitraryCode',
      params: { code: locator }
    });
    
    // For actions, show a success state briefly
    if (!isExtraction) {
      showSuccess('Action executed successfully');
    }
  } catch (error) {
    console.error('Operation failed:', error);
    showError(`Operation failed: ${error}`);
    setExecutionResult(null); // Clear result on error
  }
};
```

• Bind ⏎ key in CodeMirror to invoke `runOperation`
• **Enhanced result panel** with professional styling and better UX
• **Smart toast notifications** differentiate between actions (green success) and extractions (blue info)
• **Intelligent result callbacks** handle both extraction and action results appropriately

### 4.4 Backend – `recorderApp.ts`
Add new branch in `_handleUIEvent`:
```typescript
if (data.event === "executeArbitraryCode") {
  this._executeArbitraryCode(data.params).catch(err => {
    console.error('Failed to execute arbitrary code:', err);
    // Don't re-throw to prevent crashing the entire recorder
  });
  return;
}
```

Implementation of `_executeArbitraryCode`:
```typescript
private async _executeArbitraryCode(params: ExecuteArbitraryCodeParams) {
  const { code } = params;

  try {
    // Validation
    if (!code?.trim()) throw new Error("Code is required");

    // Get the first available page
    const pageAliases = this._recorder.pageAliases();
    if (pageAliases.size === 0) throw new Error("No pages available for code execution");

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
      action: { name: "execute_code", selector: "", args: [code], signals: [] },
      startTime: Date.now(),
    });

    try {
      // Execute the code directly on the page
      const result = await this._executePlaywrightCode(page, code);
      this._recorder.updateCallLog(callLogId, "done", result);

      // Send result back to UI if it's not undefined
      if (result !== undefined) {
        const isExtraction = this._isExtractionCommand(code);
        this._sendExtractionResultToUI(result, isExtraction ? "extraction" : "action");
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this._recorder.updateCallLog(callLogId, "error", errorMessage);
      throw e;
    }
  } catch (error) {
    throw error;
  }
}
```

### 4.5 Public API Wrapper (`_createPublicAPIWrapper`)
```typescript
private _createPublicAPIWrapper(page: Page): any {
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
    // ... other getBy methods
    // Direct page methods
    goto: (url: string) => page.mainFrame().goto(new ProgressController().run(p => p), url),
    title: () => page.title(),
    url: () => page.mainFrame().url(),
  };
}
```

The locator wrapper (`_createLocatorWrapper`) provides all standard Playwright locator methods (click, fill, innerText, etc.) that internally use frame-level API calls with proper progress controllers and error handling.

### 4.6 `Recorder` class (playwright-core/src/recorder.ts)
**Required Helper Methods** (implemented):
- `pageAliases()` – returns the Map<Page,string> already maintained for code-gen  
- `frameForSelector(selector)` – returns the main frame for execution context
- `pushTemporaryCallLog` / `updateTemporaryCallLog` – lightweight helpers for call log management

**Enhanced RecorderApp Methods** (recorderApp.ts):
- `_sendExtractionResultToUI(result, extraction)` – sends results to recorder UI page via `window.playwrightExtractionResult()`
- `_isExtractionCommand(code)` – detects whether code is an extraction or action command using regex patterns

### 4.7 Code Execution Engine
**Execution Context Setup:**
- Creates a **Public API Wrapper** that exposes familiar Playwright methods
- Makes `locator`, `getByRole`, `getByText`, etc. available as global functions
- Maps public API calls to internal frame-level operations

**Supported Operations:**
- **All Playwright locator methods** through the public API wrapper
- **Actions:** `click()`, `fill()`, `press()` with proper options support
- **Queries:** `innerText()`, `textContent()`, `isVisible()`, `isEnabled()`, `isChecked()`
- **Page methods:** `page.title()`, `page.url()`, `page.goto()`

**Error Handling:**
- Comprehensive error catching to prevent Inspector crashes
- Detailed error messages logged to console for debugging
- Graceful failure with user-friendly error toasts

### 4.8 Safety & Constraints
- **5-second timeout** on all operations (using ProgressController)
- **No arbitrary JavaScript execution** - only Playwright API methods are exposed
- **Crash prevention** - errors are caught and handled gracefully
- **Read-only for generated code** - executed operations don't affect recorded scripts

### 4.9 Telemetry (optional)  
Emit `recorder:executeArbitraryCode` events with code snippets and outcomes for product analytics.

## 5. Implementation Summary

**✅ Phase 1 – Type System & Event Wiring**  
1. ✅ Extended `recorderTypes.d.ts` with `executeArbitraryCode` event and `ExecuteArbitraryCodeParams`
2. ✅ Added event handler in `recorderApp.ts` with comprehensive error handling
3. ✅ Simplified UI by removing action/extraction dropdowns

**✅ Phase 2 – Execution Engine**  
4. ✅ Implemented `_executeArbitraryCode` method with call-log integration
5. ✅ Created `_executePlaywrightCode` with Public API wrapper
6. ✅ Built `_createPublicAPIWrapper` and `_createLocatorWrapper` for API compatibility
7. ✅ Added proper timeout handling and progress tracking

**✅ Phase 3 – Frontend Integration**  
8. ✅ Simplified action bar to single "Run Code" button
9. ✅ Updated placeholder text and removed complex UI components  
10. ✅ Maintained toast notifications and result panel for feedback
11. ✅ Preserved ⏎ key binding for quick execution

**✅ Phase 4 – Error Handling & Safety**  
12. ✅ Comprehensive error catching to prevent Inspector crashes
13. ✅ Detailed console logging for debugging
14. ✅ Public API mapping to internal Playwright frame methods
15. ✅ 5-second timeout on all operations

**✅ Phase 5 – UX Enhancements (Additional)**  
16. ✅ Enhanced result panel styling with VS Code theme integration
17. ✅ Implemented smart result clearing logic for better UX
18. ✅ Added command type detection (extraction vs action)  
19. ✅ Improved toast notification system with type-specific colors
20. ✅ Enhanced error handling and result state management

**Status: ✅ COMPLETE - Feature is fully functional with enhanced UX**

## 6. Key Design Decisions & Trade-offs

• **Full arbitrary code support** - Users can now paste complete Playwright expressions verbatim, enabling natural copy-paste workflows from documentation and existing tests
• **Public API compatibility** - The implementation provides a wrapper that makes familiar `getByRole`, `locator`, etc. methods work exactly as expected  
• **Simplified UX** - Removed complex dropdown selections in favor of direct code input, reducing cognitive overhead
• **Crash prevention** - Comprehensive error handling ensures the Inspector never crashes due to malformed code
• **No script modification** - Executed code doesn't affect generated scripts, maintaining the exploratory nature
• **Enhanced result display** - Professional styling and intelligent clearing behavior improve user experience
• **Smart type detection** - Automatic differentiation between extraction and action commands for appropriate result handling

## 7. Usage Examples

Users can now execute any of these expressions directly in the Inspector:

**Basic Actions:**
```typescript
locator("#submit-button").click()
getByRole('button', { name: 'Save' }).click()
getByPlaceholder('Email').fill('user@example.com')
```

**Extractions:**
```typescript
getByText('Welcome').innerText()
locator('.status').isVisible()
page.title()
```

**Complex Expressions:**
```typescript
getByRole('textbox', { name: 'Username' }).fill('admin')
locator('xpath=//button[contains(text(), "Submit")]').click()
```

## 8. Backward Compatibility

✅ **Fully backward compatible** - No existing public APIs changed. The original `performAction` and `performExtraction` events are preserved for any existing functionality, while the new `executeArbitraryCode` event adds the enhanced capability.

## 9. Summary

This implementation transforms the Playwright Inspector from a limited action/extraction tool into a powerful **interactive Playwright console**. Users can now execute arbitrary Playwright code directly against the live page, making it an invaluable tool for:

- **Interactive debugging** - Test locators and actions in real-time
- **Rapid prototyping** - Experiment with different approaches quickly  
- **Learning Playwright** - Try out API methods with immediate feedback
- **Troubleshooting** - Debug failing selectors or page interactions

The feature maintains the exploratory nature while dramatically expanding capabilities through the familiar Playwright API surface.
