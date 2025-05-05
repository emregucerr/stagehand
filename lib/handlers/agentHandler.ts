import { StagehandPage } from "../StagehandPage";
import { AgentProvider } from "../agent/AgentProvider";
import { StagehandAgent } from "../agent/StagehandAgent";
import { AgentClient } from "../agent/AgentClient";
import { LogLine } from "../../types/log";
import { Page } from "playwright";
import {
  AgentExecuteOptions,
  AgentAction,
  AgentResult,
  AgentHandlerOptions,
  ActionExecutionResult,
} from "@/types/agent";
import * as fs from "fs";
import * as path from "path";
// The css-selector-generator library is loaded dynamically in the browser context

// Create a type declaration for the extended Window interface
declare global {
  interface Window {
    __stagehandCursorX?: number;
    __stagehandCursorY?: number;
    __updateCursorPosition?: (x: number, y: number) => void;
    __animateClick?: (x: number, y: number) => void;
  }
}

// Define an interface for recorded actions
interface RecordedAction {
  action: string;
  timestamp: string;
  success: boolean;
  selector?: string | null;
  details: {
    button?: string;
    x?: number;
    y?: number;
    text?: string;
    keys?: string[];
    deltaX?: number;
    deltaY?: number;
    duration?: number;
    url?: string;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
    path?: { x: number; y: number }[];
    targetSelector?: string | null;
  };
}

// Define a proper type for draggable path points
interface PathPoint {
  x: number;
  y: number;
}

export class StagehandAgentHandler {
  private stagehandPage: StagehandPage;
  private agent: StagehandAgent;
  private provider: AgentProvider;
  private logger: (message: LogLine) => void;
  private agentClient: AgentClient;
  private options: AgentHandlerOptions;
  // New properties for action recording
  private recordedActions: RecordedAction[] = [];
  private sessionId: string;
  private fs: typeof fs;
  private path: typeof path;

  constructor(
    stagehandPage: StagehandPage,
    logger: (message: LogLine) => void,
    options: AgentHandlerOptions,
  ) {
    this.stagehandPage = stagehandPage;
    this.logger = logger;
    this.options = options;

    // Initialize the provider
    this.provider = new AgentProvider(logger);

    // Create client first
    const client = this.provider.getClient(
      options.modelName,
      options.clientOptions || {},
      options.userProvidedInstructions,
    );

    // Store the client
    this.agentClient = client;

    // Set up common functionality for any client type
    this.setupAgentClient();

    // Create agent with the client
    this.agent = new StagehandAgent(client, logger);

    // Initialize session ID with timestamp
    this.sessionId = `session_${Date.now()}`;

    // Initialize fs and path modules
    this.fs = fs;
    this.path = path;

    // Create the repeatables directory if it doesn't exist
    this.ensureRepeatablesDirExists();
  }

  private setupAgentClient(): void {
    // Set up screenshot provider for any client type
    this.agentClient.setScreenshotProvider(async () => {
      const screenshot = await this.stagehandPage.page.screenshot({
        fullPage: false,
      });
      // Convert to base64
      return screenshot.toString("base64");
    });

    // Set up action handler for any client type
    this.agentClient.setActionHandler(async (action) => {
      // Default delay between actions (1 second if not specified)
      const defaultDelay = 1000;
      // Use specified delay or default
      const waitBetweenActions =
        (this.options.clientOptions?.waitBetweenActions as number) ||
        defaultDelay;

      try {
        // Try to inject cursor before each action
        try {
          await this.injectCursor();
        } catch {
          // Ignore cursor injection failures
        }

        // Add a small delay before the action for better visibility
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Execute the action
        await this.executeAction(action);

        // Add a delay after the action for better visibility
        await new Promise((resolve) => setTimeout(resolve, waitBetweenActions));

        // After executing an action, take a screenshot
        try {
          await this.captureAndSendScreenshot();
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger({
            category: "agent",
            message: `Warning: Failed to take screenshot after action: ${errorMessage}. Continuing execution.`,
            level: 1,
          });
          // Continue execution even if screenshot fails
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger({
          category: "agent",
          message: `Error executing action ${action.type}: ${errorMessage}`,
          level: 0,
        });
        throw error; // Re-throw the error to be handled by the caller
      }
    });

    // Update viewport and URL for any client type
    this.updateClientViewport();
    this.updateClientUrl();
  }

  /**
   * Execute a task with the agent
   */
  async execute(
    optionsOrInstruction: AgentExecuteOptions | string,
  ): Promise<AgentResult> {
    const options =
      typeof optionsOrInstruction === "string"
        ? { instruction: optionsOrInstruction }
        : optionsOrInstruction;

    //Redirect to Google if the URL is empty or about:blank
    const currentUrl = this.stagehandPage.page.url();
    if (!currentUrl || currentUrl === "about:blank") {
      this.logger({
        category: "agent",
        message: `Page URL is empty or about:blank. Redirecting to www.google.com...`,
        level: 0,
      });
      await this.stagehandPage.page.goto("https://www.google.com");
    }

    this.logger({
      category: "agent",
      message: `Executing agent task: ${options.instruction}`,
      level: 1,
    });

    // Inject cursor for visual feedback
    try {
      await this.injectCursor();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger({
        category: "agent",
        message: `Warning: Failed to inject cursor: ${errorMessage}. Continuing with execution.`,
        level: 1,
      });
      // Continue execution even if cursor injection fails
    }

    // Take initial screenshot if needed
    if (options.autoScreenshot !== false) {
      try {
        await this.captureAndSendScreenshot();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger({
          category: "agent",
          message: `Warning: Failed to take initial screenshot: ${errorMessage}. Continuing with execution.`,
          level: 1,
        });
        // Continue execution even if screenshot fails
      }
    }

    // Reset recorded actions for a new execution
    this.recordedActions = [];
    // Generate a new session ID
    this.sessionId = `session_${Date.now()}`;

    // Execute the task
    const result = await this.agent.execute(optionsOrInstruction);

    // The actions are now executed during the agent's execution flow
    // We don't need to execute them again here

    // Save complete session of recorded actions
    await this.saveRecordedActions();

    return result;
  }

  /**
   * Execute a single action on the page
   */
  private async executeAction(
    action: AgentAction,
  ): Promise<ActionExecutionResult> {
    let result: ActionExecutionResult = { success: false };
    let targetElement: string | null = null;
    let selector: string | null = null;
    console.log("executing action", action);

    // Generate screenshot directory path with timestamp
    const screenshot_dir_path = `screenshots/${Date.now()}`;

    const screenshotsDir = path.resolve(screenshot_dir_path);
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const before_screenshot_path = path.join(screenshotsDir, `before.png`);
    const after_screenshot_path = path.join(screenshotsDir, `after.png`);

    // Take a screenshot before the action
    await this.stagehandPage.page.screenshot({
      path: before_screenshot_path,
    });
    console.log("before_screenshot_path", before_screenshot_path);
    try {
      switch (action.type) {
        case "click": {
          const { x, y, button = "left" } = action;

          // Get the element at this position BEFORE clicking
          // This ensures we capture the exact element that will be clicked
          selector = await this.generateSelector(x as number, y as number);
          this.logger({
            category: "agent",
            message: `Clicked element selector: ${selector}`,
            level: 1,
          });
          targetElement = await this.stagehandPage.page.evaluate(
            (coords) => {
              const elem = document.elementFromPoint(coords.x, coords.y);
              if (!elem) return null;

              // Capture key attributes for selector generation
              const id = elem.id ? `#${elem.id}` : null;
              const tagName = elem.tagName.toLowerCase();
              const textContent = elem.textContent?.trim();
              const className = elem.className?.toString().trim();

              return JSON.stringify({
                id,
                tagName,
                textContent,
                className,
                outerHTML: elem.outerHTML.substring(0, 500), // Limit length
              });
            },
            { x: Number(x), y: Number(y) },
          );

          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          // Animate the click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 300));
          // Perform the actual click
          await this.stagehandPage.page.mouse.click(x as number, y as number, {
            button: button as "left" | "right",
          });
          const newOpenedTab = await Promise.race([
            new Promise<Page | null>((resolve) => {
              this.stagehandPage.context.once("page", (page) => resolve(page));
              setTimeout(() => resolve(null), 1500);
            }),
          ]);
          if (newOpenedTab) {
            this.logger({
              category: "action",
              message: `New page detected (new tab) with URL. Opening on current page...`,
              level: 1,
              auxiliary: {
                url: {
                  value: newOpenedTab.url(),
                  type: "string",
                },
              },
            });
            await newOpenedTab.close();
            await this.stagehandPage.page.goto(newOpenedTab.url());
            await this.stagehandPage.page.waitForURL(newOpenedTab.url());
          }
          result = { success: true };
          break;
        }

        case "double_click": {
          const { x, y } = action;

          // Get the element at this position BEFORE clicking
          selector = await this.generateSelector(x as number, y as number);
          targetElement = await this.stagehandPage.page.evaluate(
            (coords) => {
              const elem = document.elementFromPoint(coords.x, coords.y);
              if (!elem) return null;

              // Capture key attributes for selector generation
              const id = elem.id ? `#${elem.id}` : null;
              const tagName = elem.tagName.toLowerCase();
              const textContent = elem.textContent?.trim();
              const className = elem.className?.toString().trim();

              return JSON.stringify({
                id,
                tagName,
                textContent,
                className,
                outerHTML: elem.outerHTML.substring(0, 500), // Limit length
              });
            },
            { x: Number(x), y: Number(y) },
          );

          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          // Animate the click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Animate the second click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Perform the actual double click
          await this.stagehandPage.page.mouse.dblclick(
            x as number,
            y as number,
          );
          result = { success: true };
          break;
        }

        // Handle the case for "doubleClick" as well for backward compatibility
        case "doubleClick": {
          const { x, y } = action;

          // Get the element at this position BEFORE clicking
          selector = await this.generateSelector(x as number, y as number);
          targetElement = await this.stagehandPage.page.evaluate(
            (coords) => {
              const elem = document.elementFromPoint(coords.x, coords.y);
              if (!elem) return null;

              // Capture key attributes for selector generation
              const id = elem.id ? `#${elem.id}` : null;
              const tagName = elem.tagName.toLowerCase();
              const textContent = elem.textContent?.trim();
              const className = elem.className?.toString().trim();

              return JSON.stringify({
                id,
                tagName,
                textContent,
                className,
                outerHTML: elem.outerHTML.substring(0, 500), // Limit length
              });
            },
            { x: Number(x), y: Number(y) },
          );

          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          // Animate the click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Animate the second click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Perform the actual double click
          await this.stagehandPage.page.mouse.dblclick(
            x as number,
            y as number,
          );
          result = { success: true };
          break;
        }

        case "type": {
          const { text } = action;
          await this.stagehandPage.page.keyboard.type(text as string);
          result = { success: true };
          break;
        }

        case "keypress": {
          const { keys } = action;
          if (Array.isArray(keys)) {
            // Check if CTRL or CMD is present in the keys
            const hasModifier = keys.some(
              (key) =>
                key.includes("CTRL") ||
                key.includes("CMD") ||
                key.includes("COMMAND"),
            );

            if (hasModifier) {
              // Handle key combination - press all keys simultaneously
              // Convert all keys first
              const playwrightKeys = keys.map((key) => {
                if (key.includes("CTRL")) return "Meta";
                if (key.includes("CMD") || key.includes("COMMAND"))
                  return "Meta";
                return this.convertKeyName(key);
              });

              // Press all keys down in sequence
              for (const key of playwrightKeys) {
                await this.stagehandPage.page.keyboard.down(key);
              }

              // Small delay to ensure the combination is registered
              await new Promise((resolve) => setTimeout(resolve, 100));

              // Release all keys in reverse order
              for (const key of playwrightKeys.reverse()) {
                await this.stagehandPage.page.keyboard.up(key);
              }
            } else {
              // Handle individual keys as before
              for (const key of keys) {
                // Handle special keys
                if (key.includes("ENTER")) {
                  await this.stagehandPage.page.keyboard.press("Enter");
                } else if (key.includes("SPACE")) {
                  await this.stagehandPage.page.keyboard.press(" ");
                } else if (key.includes("TAB")) {
                  await this.stagehandPage.page.keyboard.press("Tab");
                } else if (key.includes("ESCAPE") || key.includes("ESC")) {
                  await this.stagehandPage.page.keyboard.press("Escape");
                } else if (key.includes("BACKSPACE")) {
                  await this.stagehandPage.page.keyboard.press("Backspace");
                } else if (key.includes("DELETE")) {
                  await this.stagehandPage.page.keyboard.press("Delete");
                } else if (key.includes("ARROW_UP")) {
                  await this.stagehandPage.page.keyboard.press("ArrowUp");
                } else if (key.includes("ARROW_DOWN")) {
                  await this.stagehandPage.page.keyboard.press("ArrowDown");
                } else if (key.includes("ARROW_LEFT")) {
                  await this.stagehandPage.page.keyboard.press("ArrowLeft");
                } else if (key.includes("ARROW_RIGHT")) {
                  await this.stagehandPage.page.keyboard.press("ArrowRight");
                } else {
                  // For other keys, use the existing conversion
                  const playwrightKey = this.convertKeyName(key);
                  await this.stagehandPage.page.keyboard.press(playwrightKey);
                }
              }
            }
          }
          result = { success: true };
          break;
        }

        case "scroll": {
          const { scroll_x = 0, scroll_y = 0 } = action;

          try {
            // Get the current cursor position
            const cursorPosition = await this.stagehandPage.page.evaluate(
              () => {
                return {
                  x: window.__stagehandCursorX || 0,
                  y: window.__stagehandCursorY || 0,
                };
              },
            );

            // Scroll the element at the cursor position if it's scrollable, otherwise scroll the window
            await this.stagehandPage.page.evaluate(
              ({ scrollX, scrollY, cursorX, cursorY }) => {
                // Find the element at the cursor position
                const element = document.elementFromPoint(cursorX, cursorY);

                if (element) {
                  // Check if this element or any of its parents is scrollable
                  let scrollableElement: Element | null = null;
                  let currentElement: Element | null = element;

                  // Function to check if an element is scrollable
                  const isScrollable = (el: Element): boolean => {
                    const style = window.getComputedStyle(el);
                    const overflowX = style.getPropertyValue("overflow-x");
                    const overflowY = style.getPropertyValue("overflow-y");

                    // Check if element has scrollable content
                    const hasScrollableContent =
                      el.scrollHeight > el.clientHeight ||
                      el.scrollWidth > el.clientWidth;

                    // Check if element has scrollable overflow style
                    const hasScrollableStyle =
                      ["auto", "scroll"].includes(overflowY) ||
                      ["auto", "scroll"].includes(overflowX);

                    return hasScrollableStyle && hasScrollableContent;
                  };

                  // Walk up the DOM tree looking for scrollable elements
                  while (currentElement && currentElement !== document.body) {
                    if (isScrollable(currentElement)) {
                      scrollableElement = currentElement;
                      break;
                    }
                    if (currentElement.parentElement) {
                      currentElement = currentElement.parentElement;
                    } else {
                      break;
                    }
                  }

                  // If found a scrollable element, scroll it
                  if (scrollableElement) {
                    scrollableElement.scrollBy(scrollX, scrollY);
                    return; // Exit early
                  }
                }

                // Fall back to window scrolling if no scrollable element was found
                window.scrollBy(scrollX, scrollY);
              },
              {
                scrollX: scroll_x as number,
                scrollY: scroll_y as number,
                cursorX: cursorPosition.x,
                cursorY: cursorPosition.y,
              },
            );

            result = { success: true };
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            this.logger({
              category: "agent",
              message: `Error executing scroll action: ${errorMessage}`,
              level: 0,
            });
            result = {
              success: false,
              error: errorMessage,
            };
          }
          break;
        }

        case "drag": {
          const { path } = action;
          if (Array.isArray(path) && path.length >= 2) {
            const start = path[0];

            // Update cursor position for start
            await this.updateCursorPosition(start.x, start.y);
            await this.stagehandPage.page.mouse.move(start.x, start.y);
            await this.stagehandPage.page.mouse.down();

            // Update cursor position for each point in the path
            for (let i = 1; i < path.length; i++) {
              await this.updateCursorPosition(path[i].x, path[i].y);
              await this.stagehandPage.page.mouse.move(path[i].x, path[i].y);
            }

            await this.stagehandPage.page.mouse.up();
          }
          result = { success: true };
          break;
        }

        case "move": {
          const { x, y } = action;
          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          await this.stagehandPage.page.mouse.move(x as number, y as number);
          result = { success: true };
          break;
        }

        case "wait": {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          result = { success: true };
          break;
        }

        case "screenshot": {
          // Screenshot is handled automatically by the agent client
          // after each action, so we don't need to do anything here
          result = { success: true };
          break;
        }

        case "function": {
          const { name, arguments: args = {} } = action;

          if (
            name === "goto" &&
            typeof args === "object" &&
            args !== null &&
            "url" in args
          ) {
            await this.stagehandPage.page.goto(args.url as string);
            this.updateClientUrl();
            result = { success: true };
          } else if (name === "back") {
            await this.stagehandPage.page.goBack();
            this.updateClientUrl();
            result = { success: true };
          } else if (name === "forward") {
            await this.stagehandPage.page.goForward();
            this.updateClientUrl();
            result = { success: true };
          } else if (name === "reload") {
            await this.stagehandPage.page.reload();
            this.updateClientUrl();
            result = { success: true };
          } else {
            result = {
              success: false,
              error: `Unsupported function: ${name}`,
            };
          }
          break;
        }

        case "key": {
          // Handle the 'key' action type from Anthropic
          const { text } = action;
          if (text === "Return" || text === "Enter") {
            await this.stagehandPage.page.keyboard.press("Enter");
          } else if (text === "Tab") {
            await this.stagehandPage.page.keyboard.press("Tab");
          } else if (text === "Escape" || text === "Esc") {
            await this.stagehandPage.page.keyboard.press("Escape");
          } else if (text === "Backspace") {
            await this.stagehandPage.page.keyboard.press("Backspace");
          } else {
            // For other keys, try to press directly
            await this.stagehandPage.page.keyboard.press(text as string);
          }
          result = { success: true };
          break;
        }

        default:
          result = {
            success: false,
            error: `Unsupported action type: ${action.type}`,
          };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger({
        category: "agent",
        message: `Error executing action ${action.type}: ${errorMessage}`,
        level: 0,
      });

      result = {
        success: false,
        error: errorMessage,
      };
    } finally {
      // Take a screenshot after the action
      await this.stagehandPage.page.screenshot({
        path: after_screenshot_path,
      });
      console.log("after_screenshot_path", after_screenshot_path);
    }

    // Record the action and its result
    console.log("targetElement", targetElement);
    console.log("action", action);
    console.log("selector", selector);
    await this.recordAction(action, result, targetElement, selector);

    return result;
  }

  private updateClientViewport(): void {
    const viewportSize = this.stagehandPage.page.viewportSize();
    if (viewportSize) {
      this.agentClient.setViewport(viewportSize.width, viewportSize.height);
    }
  }

  private updateClientUrl(): void {
    const url = this.stagehandPage.page.url();
    this.agentClient.setCurrentUrl(url);
  }

  getAgent(): StagehandAgent {
    return this.agent;
  }

  getClient(): AgentClient {
    return this.agentClient;
  }

  async captureAndSendScreenshot(): Promise<unknown> {
    this.logger({
      category: "agent",
      message: "Taking screenshot and sending to agent",
      level: 1,
    });

    try {
      // Take screenshot of the current page
      const screenshot = await this.stagehandPage.page.screenshot({
        type: "png",
        fullPage: false,
      });

      // Convert to base64
      const base64Image = screenshot.toString("base64");

      // Just use the captureScreenshot method on the agent client
      return await this.agentClient.captureScreenshot({
        base64Image,
        currentUrl: this.stagehandPage.page.url(),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger({
        category: "agent",
        message: `Error capturing screenshot: ${errorMessage}`,
        level: 0,
      });
      return null;
    }
  }

  /**
   * Inject a cursor element into the page for visual feedback
   */
  private async injectCursor(): Promise<void> {
    try {
      // Define constants for cursor and highlight element IDs
      const CURSOR_ID = "stagehand-cursor";
      const HIGHLIGHT_ID = "stagehand-highlight";

      // Check if cursor already exists
      const cursorExists = await this.stagehandPage.page.evaluate(
        (id: string) => {
          return !!document.getElementById(id);
        },
        CURSOR_ID,
      );

      if (cursorExists) {
        return;
      }

      // Inject cursor and highlight elements
      await this.stagehandPage.page.evaluate(`
        (function(cursorId, highlightId) {
          // Create cursor element
          const cursor = document.createElement('div');
          cursor.id = cursorId;
          
          // Use the provided SVG for a custom cursor
          cursor.innerHTML = \`
          <svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 28 28" width="28" height="28">
            <polygon fill="#000000" points="9.2,7.3 9.2,18.5 12.2,15.6 12.6,15.5 17.4,15.5"/>
            <rect x="12.5" y="13.6" transform="matrix(0.9221 -0.3871 0.3871 0.9221 -5.7605 6.5909)" width="2" height="8" fill="#000000"/>
          </svg>
          \`;
          
          // Style the cursor
          cursor.style.position = 'absolute';
          cursor.style.top = '0';
          cursor.style.left = '0';
          cursor.style.width = '28px';
          cursor.style.height = '28px';
          cursor.style.pointerEvents = 'none';
          cursor.style.zIndex = '9999999';
          cursor.style.transform = 'translate(-4px, -4px)'; // Adjust to align the pointer tip
          
          // Create highlight element for click animation
          const highlight = document.createElement('div');
          highlight.id = highlightId;
          highlight.style.position = 'absolute';
          highlight.style.width = '20px';
          highlight.style.height = '20px';
          highlight.style.borderRadius = '50%';
          highlight.style.backgroundColor = 'rgba(66, 134, 244, 0)';
          highlight.style.transform = 'translate(-50%, -50%) scale(0)';
          highlight.style.pointerEvents = 'none';
          highlight.style.zIndex = '9999998';
          highlight.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
          highlight.style.opacity = '0';
          
          // Add elements to the document
          document.body.appendChild(cursor);
          document.body.appendChild(highlight);
          
          // Initialize cursor position variables
          window.__stagehandCursorX = 0;
          window.__stagehandCursorY = 0;
          
          // Add a function to update cursor position
          window.__updateCursorPosition = function(x, y) {
            if (cursor) {
              cursor.style.transform = \`translate(\${x - 4}px, \${y - 4}px)\`;
              
              // Store the cursor position for later use by other functions
              window.__stagehandCursorX = x;
              window.__stagehandCursorY = y;
            }
          };
          
          // Add a function to animate click
          window.__animateClick = function(x, y) {
            if (highlight) {
              highlight.style.left = \`\${x}px\`;
              highlight.style.top = \`\${y}px\`;
              highlight.style.transform = 'translate(-50%, -50%) scale(1)';
              highlight.style.opacity = '1';
              
              setTimeout(() => {
                highlight.style.transform = 'translate(-50%, -50%) scale(0)';
                highlight.style.opacity = '0';
              }, 300);
            }
          };
        })('${CURSOR_ID}', '${HIGHLIGHT_ID}');
      `);

      this.logger({
        category: "agent",
        message: "Cursor injected for visual feedback",
        level: 1,
      });
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Failed to inject cursor: ${error}`,
        level: 0,
      });
    }
  }

  /**
   * Update the cursor position on the page
   */
  private async updateCursorPosition(x: number, y: number): Promise<void> {
    try {
      await this.stagehandPage.page.evaluate(
        ({ x, y }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((window as any).__updateCursorPosition) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).__updateCursorPosition(x, y);
          }
        },
        { x, y },
      );
    } catch {
      // Silently fail if cursor update fails
      // This is not critical functionality
    }
  }

  /**
   * Animate a click at the given position
   */
  private async animateClick(x: number, y: number): Promise<void> {
    try {
      await this.stagehandPage.page.evaluate(
        ({ x, y }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((window as any).__animateClick) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).__animateClick(x, y);
          }
        },
        { x, y },
      );
    } catch {
      // Silently fail if animation fails
      // This is not critical functionality
    }
  }

  private convertKeyName(key: string): string {
    // Map of CUA key names to Playwright key names
    const keyMap: Record<string, string> = {
      ENTER: "Enter",
      ESCAPE: "Escape",
      BACKSPACE: "Backspace",
      TAB: "Tab",
      SPACE: " ",
      ARROWUP: "ArrowUp",
      ARROWDOWN: "ArrowDown",
      ARROWLEFT: "ArrowLeft",
      ARROWRIGHT: "ArrowRight",
      UP: "ArrowUp",
      DOWN: "ArrowDown",
      LEFT: "ArrowLeft",
      RIGHT: "ArrowRight",
      SHIFT: process.platform === "darwin" ? "Meta" : "Control", // Use Meta on macOS
      CONTROL: process.platform === "darwin" ? "Meta" : "Control", // Use Meta on macOS
      ALT: "Alt",
      META: "Meta",
      COMMAND: "Meta",
      CMD: "Meta",
      DELETE: "Delete",
      HOME: "Home",
      END: "End",
      PAGEUP: "PageUp",
      PAGEDOWN: "PageDown",
    };

    // Convert to uppercase for case-insensitive matching
    const upperKey = key.toUpperCase();

    // Return the mapped key or the original key if not found
    return keyMap[upperKey] || key;
  }

  // Ensure the repeatables directory exists
  private ensureRepeatablesDirExists(): void {
    try {
      const dirPath = this.path.join(process.cwd(), "repeatables");
      if (!this.fs.existsSync(dirPath)) {
        this.fs.mkdirSync(dirPath, { recursive: true });
        this.logger({
          category: "agent",
          message: `Created repeatables directory at ${dirPath}`,
          level: 1,
        });
      }
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error creating repeatables directory: ${error}`,
        level: 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  generateSelector.ts   – radix-safe & class-trimmed
  // ---------------------------------------------------------------------------
  private async generateSelector(x: number, y: number): Promise<string | null> {
    try {
      return await this.stagehandPage.page.evaluate(
        ({ x, y }) => {
          /*──────────────────────── helpers ────────────────────────*/
          const isSelectorUnique = (sel: string) => {
            try {
              const els = document.querySelectorAll(sel);
              return els.length === 1 && els[0] === element;
            } catch {
              return false;
            }
          };

          // … IDs that should never be used verbatim
          const isLikelyDynamicId = (id: string) =>
            id.includes(":") ||
            /^radix-/.test(id) ||
            /^[A-Za-z]+-[0-9a-f]{6,}$/.test(id);

          const stabiliseIdSelector = (sel: string) => {
            if (!sel.startsWith("#")) return sel;
            const raw = sel.slice(1).replace(/\\:/g, ":");
            if (raw.startsWith("radix-")) return `[id^="radix-"]:visible`;
            if (raw.includes(":")) return `[id="${raw}"]:visible`;
            return sel;
          };

          // reject variant / hashed classes
          const isLikelyDynamicClass = (cls: string) =>
            cls.includes(":") || // ← NEW (hover:, md:, …
            /^[a-z0-9]+$/.test(cls) ||
            /^[a-z]+(-[a-z0-9]+){2,}$/.test(cls) ||
            /^[a-z]+-[A-Za-z0-9]{4,}$/.test(cls) ||
            /css-[A-Za-z0-9]+/.test(cls) ||
            /^(ng|vue|jsx)-/.test(cls);
          /*──────────────────────────────────────────────────────────*/

          /*──────────────────────── acquire element ────────────────*/
          const element = document.elementFromPoint(x, y);
          if (!element) return null;

          /*──────────────────────── 1) id selector ─────────────────*/
          if (element.id && !isLikelyDynamicId(element.id)) {
            const idSel = `#${CSS.escape(element.id)}`;
            if (isSelectorUnique(idSel)) return idSel;
          }

          /*──────────────────────── 2) data-* attrs ───────────────*/
          const testAttrs = [
            "data-testid",
            "data-test",
            "data-cy",
            "data-automation-id",
            "data-qa",
            "data-test-id",
          ];
          for (const attr of testAttrs) {
            const val = element.getAttribute(attr);
            if (val) {
              const sel = `[${attr}="${CSS.escape(val)}"]`;
              if (isSelectorUnique(sel)) return sel;
            }
          }

          /*──────────────────────── 3) aria attrs ─────────────────*/
          const ariaAttrs = [
            "aria-label",
            "aria-labelledby",
            "aria-describedby",
            "aria-controls",
            "role",
          ];
          for (const attr of ariaAttrs) {
            const val = element.getAttribute(attr);
            if (val) {
              const sel = `${element.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
              if (isSelectorUnique(sel)) return sel;
            }
          }

          /*──────────────────────── 4) form attrs ─────────────────*/
          const formAttrs = ["name", "placeholder", "for"];
          for (const attr of formAttrs) {
            const val = element.getAttribute(attr);
            if (val) {
              const sel = `${element.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
              if (isSelectorUnique(sel)) return sel;
            }
          }

          /*──────────────────────── 5) stable classes ─────────────*/
          if (element.className && typeof element.className === "string") {
            const classes = element.className.split(/\s+/).filter(Boolean);
            const stable = classes.filter((c) => !isLikelyDynamicClass(c));

            if (stable.length) {
              const core = stable.slice(0, 3); // keep ≤ 3
              const tag = element.tagName.toLowerCase();

              // tag + all kept classes
              const allSel = `${tag}.${core.map(CSS.escape).join(".")}`;
              if (isSelectorUnique(allSel)) return allSel;

              // tag + single class
              for (const cls of core) {
                const single = `${tag}.${CSS.escape(cls)}`;
                if (isSelectorUnique(single)) return single;
              }
            }
          }

          /*──────────────────────── 6) text-based xpath ───────────*/
          const text = element.textContent?.trim();
          if (text && text.length && text.length < 50) {
            const tag = element.tagName.toLowerCase();
            if (/^(button|a|h[1-6]|label|li|span|p|div)$/i.test(tag)) {
              const exact = `//${tag}[text()="${text.replace(/"/g, '\\"')}"]`;
              if (
                document.evaluate(
                  exact,
                  document,
                  null,
                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                  null,
                ).snapshotLength === 1
              )
                return exact;

              const partial = `//${tag}[contains(text(),"${text.slice(0, 20).replace(/"/g, '\\"')}")]`;
              if (
                document.evaluate(
                  partial,
                  document,
                  null,
                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                  null,
                ).snapshotLength === 1
              )
                return partial;
            }
          }

          /*──────────────────────── 7) css path best-effort ───────*/
          try {
            let cur: Element | null = element;
            const path: string[] = [cur.tagName.toLowerCase()];

            while (cur !== document.body && cur.parentElement) {
              const sel = path.join(" > ");
              if (isSelectorUnique(sel)) return sel;

              const sibs = Array.from(cur.parentElement.children);
              if (sibs.length > 1) {
                const idx = sibs.indexOf(cur) + 1;
                path[0] = `${cur.tagName.toLowerCase()}:nth-child(${idx})`;
                const nth = path.join(" > ");
                if (isSelectorUnique(nth)) return nth;
              }
              cur = cur.parentElement;
              path.unshift(cur.tagName.toLowerCase());
            }
          } catch {
            /* ignore */
          }

          /*──────────────────────── 8) guaranteed full path ───────*/
          try {
            let cur: Element | null = element;
            const segs: string[] = [];
            while (cur && cur !== document.body && cur.parentElement) {
              const idx =
                Array.from(cur.parentElement.children).indexOf(cur) + 1;
              segs.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
              cur = cur.parentElement;
            }
            segs.unshift("body");
            return stabiliseIdSelector(segs.join(" > "));
          } catch {
            return stabiliseIdSelector(element.tagName.toLowerCase());
          }
        },
        { x, y },
      );
    } catch (err) {
      this.logger({
        category: "agent",
        message: `Error generating selector: ${err}`,
        level: 0,
      });
      return null;
    }
  }

  /**
   * Get selector for the currently active element
   */
  private async getActiveElementSelector(): Promise<string | null> {
    try {
      return await this.stagehandPage.page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return "body";

        // 1. Testing attributes (highest priority)
        if (element.getAttribute("data-testid")) {
          return `[data-testid="${element.getAttribute("data-testid")}"]`;
        }
        if (element.getAttribute("data-cy")) {
          return `[data-cy="${element.getAttribute("data-cy")}"]`;
        }
        if (element.getAttribute("data-test")) {
          return `[data-test="${element.getAttribute("data-test")}"]`;
        }
        if (element.getAttribute("data-automation-id")) {
          return `[data-automation-id="${element.getAttribute("data-automation-id")}"]`;
        }

        // 2. ID attribute
        if (element.id) {
          return `#${element.id}`;
        }

        // 3. Extended ARIA and semantic attributes
        const semanticAttributes = [
          "aria-label",
          "aria-describedby",
          "aria-controls",
          "aria-labelledby",
          "aria-haspopup",
          "aria-selected",
          "aria-expanded",
          "aria-checked",
          "title",
          "placeholder",
          "for",
          "alt",
          "name", // Include name for form elements
        ];

        for (const attr of semanticAttributes) {
          const value = element.getAttribute(attr);
          if (value) {
            // Special handling for name attribute on form elements
            if (
              attr === "name" &&
              ["input", "select", "textarea", "button"].includes(
                element.tagName.toLowerCase(),
              )
            ) {
              return `${element.tagName.toLowerCase()}[name="${value}"]`;
            }

            // Use attribute with tag for better specificity
            return `${element.tagName.toLowerCase()}[${attr}="${value}"]`;
          }
        }

        // 4. Role attribute (only if specific enough)
        const role = element.getAttribute("role");
        if (
          role &&
          !["button", "link", "presentation", "none"].includes(role)
        ) {
          return `[role="${role}"]`;
        }

        // 5. Identify stable classes from UI frameworks
        if (
          element.className &&
          typeof element.className === "string" &&
          element.className.trim()
        ) {
          const classNames = element.className.trim().split(/\s+/);

          // Filter out common dynamic class patterns
          const isDynamicClass = (className: string): boolean => {
            // CSS modules patterns (css-[hash])
            if (/^css-[a-z0-9]+$/.test(className)) return true;

            // Styled-components and emotion patterns
            if (/^(sc|e)-[a-z0-9]+$/.test(className)) return true;

            // Tailwind's JIT dynamic classes
            if (/^[a-z]+:.*$/.test(className) && className.includes(":"))
              return true;

            // Angular dynamic classes
            if (/^_ng(content|host)-[a-z0-9-]+$/.test(className)) return true;

            // Vue.js dynamic classes
            if (/^v-[a-z0-9]+$/.test(className)) return true;

            // Hash-like suffixes often used in various frameworks
            if (/^.+--[a-zA-Z0-9]+$/.test(className)) return true;

            // Numeric/hash suffixes
            if (/^.+[_-][0-9a-f]{4,}$/.test(className)) return true;

            return false;
          };

          // Look for framework-specific stable class names first
          const frameworkPatterns: Record<string, RegExp> = {
            mui: /^Mui[A-Z][a-zA-Z]+-[a-z]+$/, // Material UI: MuiButton-root
            ant: /^ant-[a-z]+-?[a-z]*$/, // Ant Design: ant-btn, ant-modal-content
            chakra: /^chakra-[a-z]+-?[a-z]*$/, // Chakra UI: chakra-button
            bootstrap:
              /^(btn|form|nav|card|modal|container|row|col)(-[a-z]+)*$/, // Bootstrap
            "react-bootstrap": /^(rb-|react-bootstrap-)/, // React Bootstrap
            "tailwind-component": /^(tw-|tailwind-)/, // Tailwind CSS with prefixes
          };

          // Check for framework-specific classes
          for (const [, pattern] of Object.entries(frameworkPatterns)) {
            const frameworkClasses = classNames.filter((className) =>
              pattern.test(className),
            );
            if (frameworkClasses.length > 0) {
              // Use attribute selector with tag and framework class for better specificity
              return `${element.tagName.toLowerCase()}[class*="${frameworkClasses[0]}"]`;
            }
          }

          // Filter out dynamic classes and keep stable ones
          const stableClasses = classNames.filter(
            (className) => !isDynamicClass(className),
          );

          if (stableClasses.length > 0) {
            return `${element.tagName.toLowerCase()}.${stableClasses.join(".")}`;
          }
        }

        // 6. Text content for interactive elements (less useful for inputs but good for buttons)
        const textContent = element.textContent?.trim();
        const interactiveElements = [
          "button",
          "a",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
        ];

        if (
          textContent &&
          textContent.length < 50 &&
          interactiveElements.includes(element.tagName.toLowerCase())
        ) {
          if (textContent.length < 20) {
            return `//${element.tagName.toLowerCase()}[text()="${textContent}"]`;
          } else {
            return `//${element.tagName.toLowerCase()}[contains(text(), "${textContent.substring(0, 20)}")]`;
          }
        }

        // 7. Last resort: tag name
        return `${element.tagName.toLowerCase()}`;
      });
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error getting active element selector: ${error}`,
        level: 0,
      });
      return null;
    }
  }

  /**
   * Record an action with necessary details
   */
  private async recordAction(
    action: AgentAction,
    result: ActionExecutionResult,
    capturedElement: string | null = null,
    selector: string | null = null,
  ): Promise<void> {
    this.logger({
      category: "agent",
      message: `Recording action: ${action.type}`,
      level: 1,
    });
    console.log("capturedElement", capturedElement);
    console.log("selector", selector);
    try {
      const timestamp = new Date().toISOString();
      let recordedAction: RecordedAction = {
        action: action.type,
        timestamp,
        success: result.success,
        details: {},
      };

      switch (action.type) {
        case "click":
        case "double_click":
        case "doubleClick": {
          const { x, y, button = "left" } = action;
          //let selector = null;
          this.logger({
            category: "agent",
            message: `Recording click action: ${x}, ${y}, ${button}`,
            level: 1,
          });

          // Use the element captured during click execution if available
          // if (capturedElement) {
          //   try {
          //     const elemData = JSON.parse(capturedElement);

          //     // Generate selector from captured element data
          //     if (elemData.id) {
          //       selector = elemData.id;
          //     } else if (
          //       elemData.tagName &&
          //       elemData.textContent &&
          //       elemData.textContent.length < 100
          //     ) {
          //       selector = `//${elemData.tagName}[text()="${elemData.textContent}"]`;
          //     } else {
          //       selector = elemData.outerHTML;
          //     }
          //   } catch (error) {
          //     // Fallback to outerHTML if JSON parsing fails
          //     this.logger({
          //       category: "agent",
          //       message: `Error parsing captured element: ${error}`,
          //       level: 0,
          //     });
          //     selector = capturedElement;
          //     selector = await this.generateSelector(x as number, y as number);
          //   }
          // } else {
          //   // Fallback to the old method if no captured element
          //   this.logger({
          //     category: "agent",
          //     message: "Falling back to generateSelector",
          //     level: 1,
          //   });
          //   selector = await this.generateSelector(x as number, y as number);
          // }

          recordedAction = {
            ...recordedAction,
            selector,
            details: {
              button: button as string,
              x: x as number,
              y: y as number,
            },
          };
          break;
        }

        case "type": {
          const { text } = action;
          const selector = await this.getActiveElementSelector();
          recordedAction = {
            ...recordedAction,
            selector,
            details: { text: text as string },
          };
          break;
        }

        case "keypress":
        case "key": {
          let keys: string[];
          if (action.type === "keypress" && Array.isArray(action.keys)) {
            keys = action.keys as string[];
          } else if (action.type === "key" && typeof action.text === "string") {
            // Convert Anthropic's 'key' action to standardized format
            keys = [action.text];
          } else {
            keys = [];
          }
          const selector = await this.getActiveElementSelector();
          recordedAction = {
            ...recordedAction,
            action: "keypress", // Standardize to keypress
            selector,
            details: { keys },
          };
          break;
        }

        case "scroll": {
          const { scroll_x = 0, scroll_y = 0 } = action;

          // Get the current cursor position
          const cursorPosition = await this.stagehandPage.page.evaluate(() => {
            return {
              x: window.__stagehandCursorX || 0,
              y: window.__stagehandCursorY || 0,
            };
          });

          // Get the selector for the element at the cursor position
          let selector = null;
          try {
            selector = await this.generateSelector(
              cursorPosition.x,
              cursorPosition.y,
            );
          } catch (error) {
            // If selector generation fails, continue without it
            this.logger({
              category: "agent",
              message: `Warning: Failed to generate selector for scroll action: ${error}`,
              level: 1,
            });
          }

          recordedAction = {
            ...recordedAction,
            action: "scrollElement",
            selector, // Element under the cursor (might be the scrolled element or a child)
            details: {
              deltaX: scroll_x as number,
              deltaY: scroll_y as number,
              x: cursorPosition.x,
              y: cursorPosition.y,
            },
          };
          break;
        }

        case "drag": {
          const { path } = action;
          if (Array.isArray(path) && path.length >= 2) {
            const startPoint = path[0] as PathPoint;
            const endPoint = path[path.length - 1] as PathPoint;

            // Get selector for the drag source element
            const sourceSelector = await this.generateSelector(
              startPoint.x,
              startPoint.y,
            );

            // Get selector for the drop target element
            const targetSelector = await this.generateSelector(
              endPoint.x,
              endPoint.y,
            );

            recordedAction = {
              ...recordedAction,
              selector: sourceSelector, // Element being dragged
              details: {
                start: { x: startPoint.x, y: startPoint.y },
                end: { x: endPoint.x, y: endPoint.y },
                path: path as PathPoint[],
                targetSelector, // Adding the drop target selector
              },
            };
          }
          break;
        }

        case "move": {
          const { x, y } = action;
          const selector = await this.generateSelector(
            x as number,
            y as number,
          );
          recordedAction = {
            ...recordedAction,
            action: "hover", // More descriptive for Playwright
            selector,
            details: { x: x as number, y: y as number },
          };
          break;
        }

        case "wait": {
          recordedAction = {
            ...recordedAction,
            details: { duration: 1000 }, // Default duration used in executeAction
          };
          break;
        }

        case "function": {
          const { name, arguments: args = {} } = action;

          if (
            name === "goto" &&
            typeof args === "object" &&
            args !== null &&
            "url" in args
          ) {
            recordedAction = {
              ...recordedAction,
              action: "goto",
              details: { url: args.url as string },
            };
          } else if (name === "back") {
            recordedAction = {
              ...recordedAction,
              action: "goBack",
              details: {},
            };
          } else if (name === "forward") {
            recordedAction = {
              ...recordedAction,
              action: "goForward",
              details: {},
            };
          } else if (name === "reload") {
            recordedAction = {
              ...recordedAction,
              action: "reload",
              details: {},
            };
          }
          break;
        }

        // Ignore screenshot action as it's not relevant for replay
        case "screenshot":
          return; // Skip recording
      }

      // Add the action to the recorded actions array
      this.recordedActions.push(recordedAction);

      // No longer saving individual actions to separate files
      // Only saving the complete session at the end
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error recording action: ${error}`,
        level: 0,
      });
    }
  }

  /**
   * Save all recorded actions to a session file
   */
  async saveRecordedActions(): Promise<void> {
    try {
      if (this.recordedActions.length === 0) {
        this.logger({
          category: "agent",
          message: "No actions to save",
          level: 1,
        });
        return;
      }

      const dirPath = this.path.join(process.cwd(), "repeatables");
      const filePath = this.path.join(
        dirPath,
        `${this.sessionId}_complete.json`,
      );

      // Write all actions to a single file
      this.fs.writeFileSync(
        filePath,
        JSON.stringify(this.recordedActions, null, 2),
      );

      this.logger({
        category: "agent",
        message: `Saved ${this.recordedActions.length} actions to ${filePath}`,
        level: 1,
      });
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error saving recorded actions: ${error}`,
        level: 0,
      });
    }
  }
}
