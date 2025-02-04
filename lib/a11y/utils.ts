import { AccessibilityNode, TreeResult, AXNode } from "../../types/context";
import { StagehandPage } from "../StagehandPage";
import { LogLine } from "../../types/log";
import { CDPSession, Page, Locator } from "playwright";
import {
  PlaywrightCommandMethodNotSupportedException,
  PlaywrightCommandException,
} from "@/types/playwright";

// Parser function for str output
export function formatSimplifiedTree(
  node: AccessibilityNode,
  level = 0,
): string {
  const indent = "  ".repeat(level);
  let result = `${indent}[${node.nodeId}] ${node.role}${
    node.name ? `: ${node.name}` : ""
  }\n`;

  if (node.children?.length) {
    result += node.children
      .map((child) => formatSimplifiedTree(child, level + 1))
      .join("");
  }
  return result;
}

/**
 * Helper function to remove or collapse unnecessary structural nodes
 * Handles three cases:
 * 1. Removes generic/none nodes with no children
 * 2. Collapses generic/none nodes with single child
 * 3. Keeps generic/none nodes with multiple children but cleans their subtrees
 */
function cleanStructuralNodes(
  node: AccessibilityNode,
): AccessibilityNode | null {
  // Filter out nodes with negative IDs
  if (node.nodeId && parseInt(node.nodeId) < 0) {
    return null;
  }

  // Base case: leaf node
  if (!node.children) {
    return node.role === "generic" || node.role === "none" ? null : node;
  }

  // Recursively clean children
  const cleanedChildren = node.children
    .map((child) => cleanStructuralNodes(child))
    .filter(Boolean) as AccessibilityNode[];

  // Handle generic/none nodes specially
  if (node.role === "generic" || node.role === "none") {
    if (cleanedChildren.length === 1) {
      // Collapse single-child generic nodes
      return cleanedChildren[0];
    } else if (cleanedChildren.length > 1) {
      // Keep generic nodes with multiple children
      return { ...node, children: cleanedChildren };
    }
    // Remove generic nodes with no children
    return null;
  }

  // For non-generic nodes, keep them if they have children after cleaning
  return cleanedChildren.length > 0
    ? { ...node, children: cleanedChildren }
    : node;
}

/**
 * Builds a hierarchical tree structure from a flat array of accessibility nodes.
 * The function processes nodes in multiple passes to create a clean, meaningful tree.
 * @param nodes - Flat array of accessibility nodes from the CDP
 * @returns Object containing both the tree structure and a simplified string representation
 */
export function buildHierarchicalTree(nodes: AccessibilityNode[]): TreeResult {
  // Map to store processed nodes for quick lookup
  const nodeMap = new Map<string, AccessibilityNode>();

  // First pass: Create nodes that are meaningful
  // We only keep nodes that either have a name or children to avoid cluttering the tree
  nodes.forEach((node) => {
    // Skip node if its ID is negative (e.g., "-1000002014")
    const nodeIdValue = parseInt(node.nodeId, 10);
    if (nodeIdValue < 0) {
      return;
    }

    const hasChildren = node.childIds && node.childIds.length > 0;
    const hasValidName = node.name && node.name.trim() !== "";
    const isInteractive =
      node.role !== "none" &&
      node.role !== "generic" &&
      node.role !== "InlineTextBox"; //add other interactive roles here

    // Include nodes that are either named, have children, or are interactive
    if (!hasValidName && !hasChildren && !isInteractive) {
      return;
    }

    // Create a clean node object with only relevant properties
    nodeMap.set(node.nodeId, {
      role: node.role,
      nodeId: node.nodeId,
      ...(hasValidName && { name: node.name }), // Only include name if it exists and isn't empty
      ...(node.description && { description: node.description }),
      ...(node.value && { value: node.value }),
      ...(node.backendDOMNodeId !== undefined && {
        backendDOMNodeId: node.backendDOMNodeId,
      }),
      ...(node.xpath && { xpath: node.xpath }),
    });
  });

  // Second pass: Establish parent-child relationships
  // This creates the actual tree structure by connecting nodes based on parentId
  nodes.forEach((node) => {
    if (node.parentId && nodeMap.has(node.nodeId)) {
      const parentNode = nodeMap.get(node.parentId);
      const currentNode = nodeMap.get(node.nodeId);

      if (parentNode && currentNode) {
        if (!parentNode.children) {
          parentNode.children = [];
        }
        parentNode.children.push(currentNode);
      }
    }
  });

  // Final pass: Build the root-level tree and clean up structural nodes
  const finalTree = nodes
    .filter((node) => !node.parentId && nodeMap.has(node.nodeId)) // Get root nodes
    .map((node) => nodeMap.get(node.nodeId))
    .filter(Boolean)
    .map((node) => cleanStructuralNodes(node))
    .filter(Boolean) as AccessibilityNode[];

  // Generate a simplified string representation of the tree
  const simplifiedFormat = finalTree
    .map((node) => formatSimplifiedTree(node))
    .join("\n");

  return {
    tree: finalTree,
    simplified: simplifiedFormat,
  };
}

/**
 * Retrieves the full accessibility tree via CDP and transforms it into a hierarchical structure.
 */
export async function getAccessibilityTree(
  page: StagehandPage,
  logger: (logLine: LogLine) => void,
): Promise<TreeResult> {
  await page.enableCDP("Accessibility");

  try {
    // Identify which elements are scrollable and get their backendNodeIds
    const scrollableBackendIds = await findScrollableElementIds(page);

    // Fetch the full accessibility tree from Chrome DevTools Protocol
    const { nodes } = await page.sendCDP<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
    );

    // For each node with a backendDOMNodeId, resolve it
    for (const node of nodes) {
      // Convert the AX role to a plain string (since .value is optional)
      const role = node.role?.value;

      if (node.backendDOMNodeId !== undefined) {
        try {
          // 1) Resolve the node to a Runtime object
          const { object } = await page.sendCDP<{
            object: { objectId?: string };
          }>("DOM.resolveNode", {
            backendNodeId: node.backendDOMNodeId,
          });

          if (object && object.objectId) {
            // 2) If valid, fetch the XPath
            try {
              const xpath = await getXPathByResolvedObjectId(
                await page.getCDPClient(),
                object.objectId,
              );
              node.xpath = xpath;
            } catch (xpathError) {
              logger({
                category: "observation",
                message: `Error fetching XPath for node ${node.backendDOMNodeId}`,
                level: 2,
                auxiliary: {
                  error: {
                    value: xpathError.message,
                    type: "string",
                  },
                },
              });
            }

            // 3) If role is 'generic' or 'none' (or name is missing),
            //    we call a function on the element to get its tagName.
            if (role === "generic" || role === "none") {
              try {
                const { result } = await page.sendCDP<{
                  result: { type: string; value?: string };
                }>("Runtime.callFunctionOn", {
                  objectId: object.objectId,
                  functionDeclaration: `
                    function() {
                      // "this" is the DOM element. Return its tagName in lowercase
                      return this.tagName ? this.tagName.toLowerCase() : "";
                    }
                  `,
                  returnByValue: true,
                });

                // If we got a tagName, store it in node.name
                if (result?.value) {
                  // Overwrite node.role, so it won't be "generic" or empty
                  node.role = { value: result.value };
                }
              } catch (tagNameError) {
                // If we can't resolve the tagName, log and skip
                logger({
                  category: "observation",
                  message: `Could not fetch tagName for node ${node.backendDOMNodeId}`,
                  level: 2,
                  auxiliary: {
                    error: {
                      value: tagNameError.message,
                      type: "string",
                    },
                  },
                });
              }
            }
          }
        } catch (resolveError) {
          logger({
            category: "observation",
            message: `Could not resolve DOM node ID ${node.backendDOMNodeId}`,
            level: 2,
            auxiliary: {
              error: {
                value: resolveError.message,
                type: "string",
              },
            },
          });
        }
      }

      if (
        node.backendDOMNodeId &&
        scrollableBackendIds.has(node.backendDOMNodeId)
      ) {
        // If this node's ID is in scrollableBackendIds,
        // We'll 'label' it by prepending 'Scrollable, ' to the role
        const existingRole = node.role?.value || "unknown";
        node.role = { value: `Scrollable, ${existingRole}` };
      }
    }

    // Now build the final hierarchical structure (including updated .name if replaced by tagName)
    const sources = nodes.map((node) => ({
      role: node.role?.value,
      name: node.name?.value,
      description: node.description?.value,
      value: node.value?.value,
      nodeId: node.nodeId,
      backendDOMNodeId: node.backendDOMNodeId,
      parentId: node.parentId,
      childIds: node.childIds,
      xpath: node.xpath,
    }));
    // Transform into hierarchical structure
    const hierarchicalTree = buildHierarchicalTree(sources);

    return hierarchicalTree;
  } catch (error) {
    logger({
      category: "observation",
      message: "Error getting accessibility tree",
      level: 1,
      auxiliary: {
        error: {
          value: error.message,
          type: "string",
        },
        trace: {
          value: error.stack,
          type: "string",
        },
      },
    });
    throw error;
  } finally {
    await page.disableCDP("Accessibility");
  }
}

// This function is wrapped into a string and sent as a CDP command
// It is not meant to be actually executed here
const functionString = `
function getNodePath(el) {
  if (!el || (el.nodeType !== Node.ELEMENT_NODE && el.nodeType !== Node.TEXT_NODE)) {
    console.log("el is not a valid node type");
    return "";
  }

  const parts = [];
  let current = el;

  while (current && (current.nodeType === Node.ELEMENT_NODE || current.nodeType === Node.TEXT_NODE)) {
    let index = 0;
    let hasSameTypeSiblings = false;
    const siblings = current.parentElement
      ? Array.from(current.parentElement.childNodes)
      : [];

    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (
        sibling.nodeType === current.nodeType &&
        sibling.nodeName === current.nodeName
      ) {
        index = index + 1;
        hasSameTypeSiblings = true;
        if (sibling.isSameNode(current)) {
          break;
        }
      }
    }

    if (!current || !current.parentNode) break;
    if (current.nodeName.toLowerCase() === "html"){
      parts.unshift("html");
      break;
    }

    // text nodes are handled differently in XPath
    if (current.nodeName !== "#text") {
      const tagName = current.nodeName.toLowerCase();
      const pathIndex = hasSameTypeSiblings ? \`[\${index}]\` : "";
      parts.unshift(\`\${tagName}\${pathIndex}\`);
    }
    
    current = current.parentElement;
  }

  return parts.length ? \`/\${parts.join("/")}\` : "";
}`;

export async function getXPathByResolvedObjectId(
  cdpClient: CDPSession,
  resolvedObjectId: string,
): Promise<string> {
  const { result } = await cdpClient.send("Runtime.callFunctionOn", {
    objectId: resolvedObjectId,
    functionDeclaration: `function() {
      ${functionString}
      return getNodePath(this);
    }`,
    returnByValue: true,
  });

  return result.value || "";
}

/**
 * `findScrollableElementIds` is a function that identifies elements in
 * the browser that are deemed "scrollable". At a high level, it does the
 * following:
 * - Calls the browser-side `window.getScrollableElementXpaths()` function,
 *   which returns a list of XPaths for scrollable containers.
 * - Iterates over the returned list of XPaths, locating each element in the DOM
 *   using `stagehandPage.sendCDP(...)`
 *     - During each iteration, we call `Runtime.evaluate` to run `document.evaluate(...)`
 *       with each XPath, obtaining a `RemoteObject` reference if it exists.
 *     - Then, for each valid object reference, we call `DOM.describeNode` to retrieve
 *       the element’s `backendNodeId`.
 * - Collects all resulting `backendNodeId`s in a Set and returns them.
 *
 * @param stagehandPage - A StagehandPage instance with built-in CDP helpers.
 * @returns A Promise that resolves to a Set of unique `backendNodeId`s corresponding
 *          to scrollable elements in the DOM.
 */
export async function findScrollableElementIds(
  stagehandPage: StagehandPage,
): Promise<Set<number>> {
  // get the xpaths of the scrollable elements
  const xpaths = await stagehandPage.page.evaluate(() => {
    return window.getScrollableElementXpaths();
  });

  const scrollableBackendIds = new Set<number>();

  for (const xpath of xpaths) {
    if (!xpath) continue;

    // evaluate the XPath in the stagehandPage
    const { result } = await stagehandPage.sendCDP<{
      result?: { objectId?: string };
    }>("Runtime.evaluate", {
      expression: `
        (function() {
          const res = document.evaluate(${JSON.stringify(
            xpath,
          )}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return res.singleNodeValue;
        })();
      `,
      returnByValue: false,
    });

    // if we have an objectId, call DOM.describeNode to get backendNodeId
    if (result?.objectId) {
      const { node } = await stagehandPage.sendCDP<{
        node?: { backendNodeId?: number };
      }>("DOM.describeNode", {
        objectId: result.objectId,
      });

      if (node?.backendNodeId) {
        scrollableBackendIds.add(node.backendNodeId);
      }
    }
  }

  return scrollableBackendIds;
}

export async function performPlaywrightMethod(
  stagehandPage: Page,
  logger: (logLine: LogLine) => void,
  method: string,
  args: unknown[],
  xpath: string,
  // domSettleTimeoutMs?: number,
) {
  const locator = stagehandPage.locator(`xpath=${xpath}`).first();
  const initialUrl = stagehandPage.url();

  logger({
    category: "action",
    message: "performing playwright method",
    level: 2,
    auxiliary: {
      xpath: {
        value: xpath,
        type: "string",
      },
      method: {
        value: method,
        type: "string",
      },
    },
  });

  if (method === "scrollIntoView") {
    logger({
      category: "action",
      message: "scrolling element into view",
      level: 2,
      auxiliary: {
        xpath: {
          value: xpath,
          type: "string",
        },
      },
    });
    try {
      await locator
        .evaluate((element: HTMLElement) => {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        })
        .catch((e: Error) => {
          logger({
            category: "action",
            message: "error scrolling element into view",
            level: 1,
            auxiliary: {
              error: {
                value: e.message,
                type: "string",
              },
              trace: {
                value: e.stack,
                type: "string",
              },
              xpath: {
                value: xpath,
                type: "string",
              },
            },
          });
        });
    } catch (e) {
      logger({
        category: "action",
        message: "error scrolling element into view",
        level: 1,
        auxiliary: {
          error: {
            value: e.message,
            type: "string",
          },
          trace: {
            value: e.stack,
            type: "string",
          },
          xpath: {
            value: xpath,
            type: "string",
          },
        },
      });

      throw new PlaywrightCommandException(e.message);
    }
  } else if (method === "fill" || method === "type") {
    try {
      await locator.fill("");
      await locator.click();
      const text = args[0]?.toString();
      for (const char of text) {
        await stagehandPage.keyboard.type(char, {
          delay: Math.random() * 50 + 25,
        });
      }
    } catch (e) {
      logger({
        category: "action",
        message: "error filling element",
        level: 1,
        auxiliary: {
          error: {
            value: e.message,
            type: "string",
          },
          trace: {
            value: e.stack,
            type: "string",
          },
          xpath: {
            value: xpath,
            type: "string",
          },
        },
      });

      throw new PlaywrightCommandException(e.message);
    }
  } else if (method === "press") {
    try {
      const key = args[0]?.toString();
      await stagehandPage.keyboard.press(key);
    } catch (e) {
      logger({
        category: "action",
        message: "error pressing key",
        level: 1,
        auxiliary: {
          error: {
            value: e.message,
            type: "string",
          },
          trace: {
            value: e.stack,
            type: "string",
          },
          key: {
            value: args[0]?.toString() ?? "unknown",
            type: "string",
          },
        },
      });

      throw new PlaywrightCommandException(e.message);
    }
  } else if (typeof locator[method as keyof typeof locator] === "function") {
    // Log current URL before action
    logger({
      category: "action",
      message: "page URL before action",
      level: 2,
      auxiliary: {
        url: {
          value: stagehandPage.url(),
          type: "string",
        },
      },
    });

    // Perform the action
    try {
      await (
        locator[method as keyof Locator] as unknown as (
          ...args: string[]
        ) => Promise<void>
      )(...args.map((arg) => arg?.toString() || ""));
    } catch (e) {
      logger({
        category: "action",
        message: "error performing method",
        level: 1,
        auxiliary: {
          error: {
            value: e.message,
            type: "string",
          },
          trace: {
            value: e.stack,
            type: "string",
          },
          xpath: {
            value: xpath,
            type: "string",
          },
          method: {
            value: method,
            type: "string",
          },
          args: {
            value: JSON.stringify(args),
            type: "object",
          },
        },
      });

      throw new PlaywrightCommandException(e.message);
    }

    // Handle navigation if a new page is opened
    if (method === "click") {
      logger({
        category: "action",
        message: "clicking element, checking for page navigation",
        level: 1,
        auxiliary: {
          xpath: {
            value: xpath,
            type: "string",
          },
        },
      });

      const newOpenedTab = await Promise.race([
        new Promise<Page | null>((resolve) => {
          Promise.resolve(stagehandPage.context()).then((context) => {
            context.once("page", (page: Page) => resolve(page));
            setTimeout(() => resolve(null), 1_500);
          });
        }),
      ]);

      logger({
        category: "action",
        message: "clicked element",
        level: 1,
        auxiliary: {
          newOpenedTab: {
            value: newOpenedTab ? "opened a new tab" : "no new tabs opened",
            type: "string",
          },
        },
      });

      if (newOpenedTab) {
        logger({
          category: "action",
          message: "new page detected (new tab) with URL",
          level: 1,
          auxiliary: {
            url: {
              value: newOpenedTab.url(),
              type: "string",
            },
          },
        });
        await newOpenedTab.close();
        await stagehandPage.goto(newOpenedTab.url());
        await stagehandPage.waitForLoadState("domcontentloaded");
        // await stagehandPage._waitForSettledDom(domSettleTimeoutMs);
      }

      await Promise.race([
        stagehandPage.waitForLoadState("networkidle"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]).catch((e) => {
        logger({
          category: "action",
          message: "network idle timeout hit",
          level: 1,
          auxiliary: {
            trace: {
              value: e.stack,
              type: "string",
            },
            message: {
              value: e.message,
              type: "string",
            },
          },
        });
      });

      logger({
        category: "action",
        message: "finished waiting for (possible) page navigation",
        level: 1,
      });

      if (stagehandPage.url() !== initialUrl) {
        logger({
          category: "action",
          message: "new page detected with URL",
          level: 1,
          auxiliary: {
            url: {
              value: stagehandPage.url(),
              type: "string",
            },
          },
        });
      }
    }
  } else {
    logger({
      category: "action",
      message: "chosen method is invalid",
      level: 1,
      auxiliary: {
        method: {
          value: method,
          type: "string",
        },
      },
    });

    throw new PlaywrightCommandMethodNotSupportedException(
      `Method ${method} not supported`,
    );
  }

  // await stagehandPage._waitForSettledDom(domSettleTimeoutMs);
}
