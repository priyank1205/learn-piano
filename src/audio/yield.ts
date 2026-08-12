/**
 * Yield to the event loop without being background-throttled.
 *
 * Chrome limits `setTimeout` in a hidden tab to roughly one firing per second.
 * That is invisible in development and brutal in practice: it turned the
 * one-second sample bank build into thirteen seconds and the 200ms clock
 * calibration into eight, purely because the tab was not in front. A
 * MessageChannel message is a macrotask that background throttling does not
 * touch, so startup costs the same whether or not the user is looking at it.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}
