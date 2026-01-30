
// DOM Selectors
const SELECTORS = {
    USER_MESSAGE: '[data-message-author-role="user"]',
    USER_MESSAGE_ALT: '[data-message-role="user"]',
    INJECTION_TARGET: 'main',
    CHAT_CONTAINER: '[class*="react-scroll-to-bottom"]',
};

let tabsContainer = null;
let isTabModeEnabled = true;
let activeTabIndex = 0;
let explicitlySelected = false;
let observer = null;
let isInitialized = false;
let isUpdating = false; // Prevent re-entrant calls
let lastUpdateHash = ''; // Track if content actually changed

// Comprehensive error logging
function logError(context, error) {
    console.error(`[GPT Tab UI Error - ${context}]:`, error);
    console.error('Stack trace:', error.stack);
}

function logInfo(message, data = null) {
    if (data) {
        console.log(`[GPT Tab UI]: ${message}`, data);
    } else {
        console.log(`[GPT Tab UI]: ${message}`);
    }
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// Wait for ChatGPT to be fully loaded
function waitForChatGPTLoad() {
    return new Promise((resolve) => {
        logInfo('Waiting for ChatGPT to load...');

        // Check if main content is already available
        const checkLoad = () => {
            try {
                const main = document.querySelector(SELECTORS.INJECTION_TARGET);

                if (main) {
                    logInfo('Main element found', { main });
                    // Wait a bit more to ensure content is rendered
                    setTimeout(() => {
                        logInfo('ChatGPT loaded successfully');
                        resolve(true);
                    }, 1000);
                } else {
                    logInfo('Main element not found yet, retrying...');
                    setTimeout(checkLoad, 500);
                }
            } catch (error) {
                logError('waitForChatGPTLoad', error);
                setTimeout(checkLoad, 500);
            }
        };

        checkLoad();
    });
}

function init() {
    try {
        logInfo('Extension script loaded');

        // Wait for page to be fully loaded
        waitForChatGPTLoad().then(() => {
            logInfo('Starting initialization');

            // Set up mutation observer with debouncing
            const debouncedUpdate = debounce(() => {
                try {
                    updateTabs();
                } catch (error) {
                    logError('updateTabs (debounced)', error);
                }
            }, 300);

            observer = new MutationObserver((mutations) => {
                try {
                    // Ignore mutations while we're updating
                    if (isUpdating) {
                        return;
                    }

                    // Filter out mutations that are only class changes to our hidden elements
                    const relevantMutation = mutations.some(mutation => {
                        // Ignore our own class changes
                        if (mutation.type === 'attributes' &&
                            mutation.attributeName === 'class' &&
                            mutation.target.classList.contains('gpt-hidden')) {
                            return false;
                        }
                        // Ignore changes to our tabs container
                        if (mutation.target.id === 'gpt-tabs-container' ||
                            mutation.target.closest('#gpt-tabs-container')) {
                            return false;
                        }
                        return true;
                    });

                    if (!relevantMutation) {
                        return;
                    }

                    const target = document.querySelector(SELECTORS.INJECTION_TARGET);
                    if (target) {
                        debouncedUpdate();
                    }
                } catch (error) {
                    logError('MutationObserver callback', error);
                }
            });

            const body = document.querySelector('body');
            if (body) {
                observer.observe(body, {
                    childList: true,
                    subtree: true,
                    attributes: false // Don't observe attribute changes to reduce noise
                });
                logInfo('MutationObserver attached');
            } else {
                logError('init', new Error('Body element not found'));
            }

            // Do initial update
            try {
                updateTabs();
            } catch (error) {
                logError('Initial updateTabs', error);
            }

            isInitialized = true;
            logInfo('Initialization complete');
        }).catch((error) => {
            logError('init - waitForChatGPTLoad', error);
        });

    } catch (error) {
        logError('init', error);
    }
}

function updateTabs() {
    // Prevent re-entrant calls
    if (isUpdating) {
        return;
    }

    try {
        isUpdating = true;

        // Temporarily disconnect observer to prevent triggering during our changes
        if (observer) {
            observer.disconnect();
        }

        if (!isTabModeEnabled) {
            return;
        }

        // 1. Validation
        const userMsgSample = document.querySelector(SELECTORS.USER_MESSAGE) ||
                            document.querySelector(SELECTORS.USER_MESSAGE_ALT);

        if (!userMsgSample) {
            if (tabsContainer) {
                tabsContainer.style.display = 'none';
            }
            return;
        }

        // 2. Identification
        let turnWrapper = userMsgSample.closest('article');
        if (!turnWrapper) {
            turnWrapper = userMsgSample.closest('.group') ||
                         userMsgSample.closest('div[class*="group"]') ||
                         userMsgSample.parentElement;
        }

        if (!turnWrapper) {
            return;
        }

        if (!turnWrapper.parentElement) {
            return;
        }

        const mainListContainer = turnWrapper.parentElement;

        // 3. Inject Container
        if (!tabsContainer || !document.contains(tabsContainer)) {
            logInfo('Creating tabs container');

            tabsContainer = document.createElement('div');
            tabsContainer.id = 'gpt-tabs-container';

            const tabsNav = document.createElement('div');
            tabsNav.className = 'gpt-nav-tabs';
            tabsContainer.appendChild(tabsNav);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'gpt-close-btn';
            closeBtn.innerText = '✕';
            closeBtn.title = 'Disable tab mode';
            closeBtn.onclick = () => {
                try {
                    logInfo('Disabling tab mode');
                    isTabModeEnabled = false;
                    tabsContainer.style.display = 'none';

                    // Unhide everything
                    const allHidden = document.querySelectorAll('.gpt-hidden');
                    logInfo('Unhiding elements', { count: allHidden.length });
                    allHidden.forEach(el => el.classList.remove('gpt-hidden'));
                } catch (error) {
                    logError('closeBtn click', error);
                }
            };
            tabsContainer.appendChild(closeBtn);

            // Inject into main
            const mainEl = document.querySelector('main');
            if (mainEl && mainEl.contains(mainListContainer)) {
                mainEl.insertBefore(tabsContainer, mainEl.firstChild);
                logInfo('Tabs container injected into main');
            } else if (mainListContainer.parentElement) {
                mainListContainer.parentElement.insertBefore(tabsContainer, mainListContainer);
                logInfo('Tabs container injected before main list container');
            } else {
                logError('injection', new Error('Could not find suitable injection point'));
                return;
            }
        }

        tabsContainer.style.display = 'flex';

        // 4. Grouping
        const children = Array.from(mainListContainer.children);
        const turns = [];
        let currentTurn = null;

        children.forEach((child, idx) => {
            try {
                // Skip our tabs container
                if (child.id === 'gpt-tabs-container') return;

                const isUser = child.querySelector(SELECTORS.USER_MESSAGE) ||
                              child.querySelector(SELECTORS.USER_MESSAGE_ALT);

                if (isUser) {
                    const title = isUser.textContent.trim();
                    currentTurn = {
                        title: title || `Question ${turns.length + 1}`,
                        elements: [child]
                    };
                    turns.push(currentTurn);
                } else {
                    if (currentTurn) {
                        currentTurn.elements.push(child);
                    }
                    // Elements before first user message are left visible
                }
            } catch (error) {
                logError(`Processing child ${idx}`, error);
            }
        });

        // If no turns found, bail out
        if (turns.length === 0) {
            children.forEach(c => {
                try {
                    c.classList.remove('gpt-hidden');
                } catch (error) {
                    logError('unhiding child', error);
                }
            });
            return;
        }

        // Create content hash to detect actual changes
        const contentHash = turns.map(t => t.title).join('|');
        if (contentHash === lastUpdateHash && !explicitlySelected) {
            // Content hasn't changed, skip update
            return;
        }
        lastUpdateHash = contentHash;

        // 5. State management
        let targetIndex = turns.length - 1; // Default to last turn
        if (explicitlySelected) {
            if (activeTabIndex < turns.length && activeTabIndex >= 0) {
                targetIndex = activeTabIndex;
            } else {
                targetIndex = turns.length - 1;
            }
            explicitlySelected = false; // Reset after use
        }
        activeTabIndex = targetIndex;

        // 6. Render tabs
        const nav = tabsContainer.querySelector('.gpt-nav-tabs');
        if (!nav) {
            logError('render', new Error('Nav element not found'));
            return;
        }

        nav.innerHTML = '';

        turns.forEach((turn, index) => {
            try {
                const tabLink = document.createElement('button');
                tabLink.className = 'gpt-nav-link';
                if (index === activeTabIndex) {
                    tabLink.classList.add('active');
                }

                tabLink.innerText = truncateText(turn.title, 20);
                tabLink.title = turn.title; // Full text on hover
                tabLink.onclick = () => {
                    try {
                        explicitlySelected = true;
                        activeTabIndex = index;
                        updateTabs();
                    } catch (error) {
                        logError('tab click', error);
                    }
                };

                nav.appendChild(tabLink);
            } catch (error) {
                logError(`Rendering tab ${index}`, error);
            }
        });

        // 7. Visibility control
        turns.forEach((turn, index) => {
            try {
                const shouldShow = (index === activeTabIndex);
                turn.elements.forEach(el => {
                    try {
                        if (shouldShow) {
                            el.classList.remove('gpt-hidden');
                        } else {
                            el.classList.add('gpt-hidden');
                        }
                    } catch (error) {
                        logError('toggling element visibility', error);
                    }
                });
            } catch (error) {
                logError(`Processing turn ${index} visibility`, error);
            }
        });

        logInfo(`Tabs updated: ${turns.length} turns, showing tab ${activeTabIndex + 1}`);

    } catch (error) {
        logError('updateTabs', error);

        // On error, try to unhide everything to prevent blank page
        try {
            const allHidden = document.querySelectorAll('.gpt-hidden');
            allHidden.forEach(el => el.classList.remove('gpt-hidden'));
            logInfo('Emergency unhide completed');
        } catch (unhideError) {
            logError('Emergency unhide', unhideError);
        }
    } finally {
        // Always reconnect observer and reset flag
        isUpdating = false;

        if (observer) {
            const body = document.querySelector('body');
            if (body) {
                observer.observe(body, {
                    childList: true,
                    subtree: true,
                    attributes: false
                });
            }
        }
    }
}

function truncateText(text, len) {
    if (!text) return "Question";
    return text.length > len ? text.substring(0, len) + "..." : text;
}

// Global error handler
window.addEventListener('error', (event) => {
    if (event.filename && event.filename.includes('content.js')) {
        logError('Global error', event.error || event.message);
    }
});

// Start initialization
try {
    if (document.readyState === 'loading') {
        logInfo('Document still loading, waiting for DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', init);
    } else {
        logInfo('Document already loaded, initializing immediately');
        init();
    }
} catch (error) {
    logError('Script startup', error);
}
