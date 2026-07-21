/**
 * lib/slack.js — attachments, the one thing this server has to fetch itself.
 *
 * The dashboard does not talk to Slack. Mentions, threads, replies and Linear
 * all happen inside a Claude session through the claude.ai MCP connectors, and
 * that is deliberate. Files are the single exception, and they have to be:
 * every attachment lives behind `files.slack.com`, which serves *nothing*
 * without an `Authorization` header. Point a browser `<img src>` at a Slack URL
 * and you get a 302 to the login page — which is why a message that plainly
 * said "video attached" rendered as text with nothing under it.
 *
 * Two halves, both cheap:
 *
 *   metadata  scripts/probe.js already receives `files[]` on every
 *             `search.messages` match it was going to read anyway. Recording it
 *             costs one more field on a mention and zero extra API calls.
 *   bytes     GET /api/slack/file streams the file through this process with
 *             the token attached, so the page only ever sees a same-origin URL
 *             and the token never reaches the browser.
 *
 * Scope: the probe's token needs `files:read` on top of `search:read`. Slack
 * answers a missing scope on files.slack.com with a *redirect to the login
 * page*, not an error — so fetchFile() reads a redirect as the failure it is
 * rather than streaming an HTML login form back as if it were a video.
 */

const env = require("./env");

/** The only host we will ever put the token on. A recorded URL is still a URL
 *  that came off the network, and the proxy must not become a way to make this
 *  process fetch arbitrary things with a credential attached. */
const FILE_HOST = "files.slack.com";

/** Types safe to hand a browser inline from our own origin. Everything else is
 *  served as a download: an attachment is bytes someone else chose, and the
 *  dashboard's origin is one that can start a Claude session. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac|x-m4a))$/;

function isFileUrl(u) {
  try {
    const url = new URL(String(u || ""));
    return url.protocol === "https:" && url.host === FILE_HOST;
  } catch {
    return false;
  }
}

/**
 * What the chat draws it with. Slack's file object has ~60 fields and most of
 * them are about Slack's own UI; a run file keeps the handful a bubble needs.
 *
 * `kind` rather than a raw mimetype because the renderer's question is "img,
 * video, audio, or a row with a download link" — and Slack answers it in two
 * different places (`media_display_type` for anything it transcoded,
 * `mimetype` for everything else).
 */
function kindOf(f) {
  const mime = String(f.mimetype || "");
  if (f.media_display_type === "video" || mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function normalizeFile(f) {
  if (!f || !f.id) return null;
  const kind = kindOf(f);

  // A screen recording arrives as `video/quicktime` (.mov), which plays in
  // roughly no browser. Slack transcodes one to mp4 and hands the URL over in
  // `mp4` — prefer it, and only then is it honest to call the bytes mp4.
  const transcoded = kind === "video" && isFileUrl(f.mp4) ? String(f.mp4) : "";
  const url = transcoded || String(f.url_private || "");
  if (!isFileUrl(url)) return null;

  // The poster frame for a video. Images deliberately have none: a thumb of a
  // 2660px-wide screenshot is unreadable, and on loopback the original costs
  // nothing to send.
  const thumb = kind === "video" && isFileUrl(f.thumb_video) ? String(f.thumb_video) : "";

  return {
    id: String(f.id),
    name: String(f.title || f.name || "attachment"),
    kind,
    mime: transcoded ? "video/mp4" : String(f.mimetype || "application/octet-stream"),
    size: Number(f.size) || 0,
    w: Number(f.original_w || f.thumb_video_w) || 0,
    h: Number(f.original_h || f.thumb_video_h) || 0,
    durationMs: Number(f.duration_ms) || 0,
    url,
    thumb,
    // Always worth carrying: it opens in the browser's own Slack session, so
    // it is the fallback that still works when the token can't fetch bytes.
    permalink: String(f.permalink || ""),
  };
}

/** Every attachment on a `search.messages` match, in post order. */
function filesOf(match) {
  const raw = (match && match.files) || [];
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeFile).filter(Boolean);
}

/**
 * Fetch one recorded file URL with the token on it.
 *
 * `redirect: "manual"` is load-bearing. A token without `files:read` does not
 * get a 401 from files.slack.com — it gets a 302 to the workspace login page,
 * and following it yields 200 OK with an HTML body. Streaming *that* into a
 * `<video>` is a silent failure that looks like a codec problem.
 *
 * Range is forwarded untouched so seeking in a 5-minute screen recording asks
 * Slack for the byte window rather than pulling the whole file again.
 */
async function fetchFile(url, { range } = {}) {
  if (!isFileUrl(url)) throw new Error("not a Slack file URL");
  const token = env.slackUserToken;
  if (!token) throw new Error("no SLACK_USER_TOKEN — cannot fetch Slack attachments");

  const headers = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = String(range);

  const res = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error("Slack redirected to a login page — the user token is missing the files:read scope");
  }
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`Slack returned ${res.status} for the attachment`);
  }
  return res;
}

module.exports = { INLINE, filesOf, normalizeFile, fetchFile, isFileUrl };
