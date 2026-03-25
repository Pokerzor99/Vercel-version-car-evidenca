function unauthorizedResponse() {
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Protected area"'
    }
  });
}

function decodeBasicAuthBase64(encoded) {
  // Middleware runs in Vercel Edge-like environments where `atob` is usually available,
  // but we also support Node-style `Buffer` when present.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  if (typeof atob === "function") {
    return atob(encoded);
  }
  throw new Error("No base64 decoder available");
}

export default function middleware(request) {
  const expectedUser = process.env.APP_BASIC_AUTH_USER;
  const expectedPass = process.env.APP_BASIC_AUTH_PASS;

  // Fail closed: if env vars are missing, we should still require auth.
  // This makes misconfiguration obvious and prevents accidentally public deployments.
  if (!expectedUser || !expectedPass) return unauthorizedResponse();

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorizedResponse();
  }

  try {
    const encoded = authHeader.slice("Basic ".length).trim();
    const decoded = decodeBasicAuthBase64(encoded);
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) return unauthorizedResponse();

    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);
    if (user !== expectedUser || pass !== expectedPass) return unauthorizedResponse();

    return;
  } catch {
    return unauthorizedResponse();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
