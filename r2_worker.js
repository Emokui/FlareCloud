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

const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;

function getMaxRangeBytes(env) {
  const value = Number(env?.RANGE_MAX_BYTES);
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_MAX_RANGE_BYTES;
}

function parseRange(rangeHeader, maxBytes) {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return { invalid: true };

  const startStr = m[1];
  const endStr = m[2];

  if (startStr === "" && endStr === "") return { invalid: true };
  if (startStr === "") return { invalid: true };

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0) return { invalid: true };

  let end;
  let length;
  if (endStr === "") {
    length = maxBytes;
    end = start + length - 1;
  } else {
    end = Number(endStr);
    if (!Number.isFinite(end) || end < start) return { invalid: true };
    length = end - start + 1;
  }

  if (length > maxBytes) return { tooLarge: true };

  return { offset: start, length, start, end };
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
    const rangeReq = parseRange(rangeHeader, getMaxRangeBytes(env));

    if (rangeHeader && (rangeReq?.invalid || rangeReq?.tooLarge)) {
      return new Response("Range Not Satisfiable", { status: 416 });
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

      const totalSize = obj.size;
      if (typeof totalSize === "number" && rangeReq.start >= totalSize) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${totalSize}` },
        });
      }

      const end = typeof totalSize === "number"
        ? Math.min(rangeReq.start + rangeReq.length - 1, totalSize - 1)
        : rangeReq.end;
      const length = end - rangeReq.start + 1;

      headers.set(
        "Content-Range",
        typeof totalSize === "number"
          ? `bytes ${rangeReq.start}-${end}/${totalSize}`
          : `bytes ${rangeReq.start}-${end}/*`
      );
      headers.set("Content-Length", String(length));

      return new Response(request.method === "HEAD" ? null : obj.body, {
        status: 206,
        headers,
      });
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
