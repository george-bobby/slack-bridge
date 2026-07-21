/**
 * Tiny server-sent-events bus.
 *
 * The dashboard used to re-poll /api/state every 4s and re-render everything.
 * That is fine for a page of toggles and hopeless for a chat: a follow-up
 * streams tokens for minutes, and re-fetching the whole world on a timer both
 * flickers and loses the caret. So the server pushes instead — one SSE stream
 * per tab, one named event per thing that actually changed.
 */

const clients = new Set();

function subscribe(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);

  // Proxies and sleeping laptops drop idle streams silently; a comment every
  // 20s keeps the connection warm and lets the browser notice a dead one.
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* the close handler below cleans up */
    }
  }, 20000);

  const close = () => {
    clearInterval(ping);
    clients.delete(res);
  };
  req.on("close", close);
  req.on("error", close);
  res.on("error", close);
}

function broadcast(event, data) {
  if (!clients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

module.exports = { subscribe, broadcast };
