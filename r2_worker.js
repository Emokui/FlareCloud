function normalizeKey(pathname) {
  let key;
  try {
    key = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  key = key.replace(/^\/+/, "");

  if (key === "") return "index.html";
  if (key.endsWith("/")) return key + "index.html";

  if (key.includes("..") || key.includes("\0")) return null;

  return key;
}

function hasValidRangeFormat(header) {
  return header && /^bytes=\d*-\d*$/.test(header);
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;

  const startStr = m[1];
  const endStr = m[2];

  if (startStr === "" && endStr === "") return null;

  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;

    const length = Math.min(suffix, size);
    const start = Math.max(0, size - length);
    const end = size - 1;

    return { offset: start, length, start, end };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0) return null;

  if (endStr === "") {
    if (start >= size) return { unsatisfiable: true };

    const end = size - 1;
    const length = size - start;

    return { offset: start, length, start, end };
  }

  const end = Number(endStr);
  if (!Number.isFinite(end) || end < start) return null;
  if (start >= size) return { unsatisfiable: true };

  const clampedEnd = Math.min(end, size - 1);
  const length = clampedEnd - start + 1;

  return { offset: start, length, start, end: clampedEnd };
}

function build304Headers(obj) {
  const h = new Headers();
  h.set("ETag", obj.httpEtag);
  h.set("Last-Modified", obj.uploaded.toUTCString());
  if (obj.httpMetadata?.cacheControl) h.set("Cache-Control", obj.httpMetadata.cacheControl);
  return h;
}

function withCommonHeaders(obj, headers) {
  obj.writeHttpMetadata(headers);

  headers.set("ETag", obj.httpEtag);
  headers.set("Last-Modified", obj.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");

  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const key = normalizeKey(url.pathname);
    if (!key) return new Response("Bad Request", { status: 400 });

    const rangeHeader = request.headers.get("Range");

    if (hasValidRangeFormat(rangeHeader)) {
      const head = await env.BUCKET.head(key);
      if (!head) return new Response("Not Found", { status: 404 });

      const size = head.size;
      const rangeReq = parseRange(rangeHeader, size);

      if (rangeReq?.unsatisfiable) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }

      if (rangeReq) {
        const obj = await env.BUCKET.get(key, {
          onlyIf: request.headers,
          range: { offset: rangeReq.offset, length: rangeReq.length },
        });

        if (!obj) return new Response("Not Found", { status: 404 });

        if (!obj.body) {
          return new Response(null, { status: 304, headers: build304Headers(obj) });
        }

        const headers = new Headers();
        withCommonHeaders(obj, headers);

        headers.set("Content-Range", `bytes ${rangeReq.start}-${rangeReq.end}/${size}`);
        headers.set("Content-Length", String(rangeReq.length));

        return new Response(request.method === "HEAD" ? null : obj.body, {
          status: 206,
          headers,
        });
      }
    }

    const obj = await env.BUCKET.get(key, { onlyIf: request.headers });
    if (!obj) return new Response("Not Found", { status: 404 });

    if (!obj.body) {
      return new Response(null, { status: 304, headers: build304Headers(obj) });
    }

    const headers = new Headers();
    withCommonHeaders(obj, headers);
    headers.set("Content-Length", String(obj.size));

    return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
  },
};