function unauthorizedResponse() {
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Protected area"'
    }
  });
}

export default function middleware(request) {
  const expectedUser = process.env.APP_BASIC_AUTH_USER;
  const expectedPass = process.env.APP_BASIC_AUTH_PASS;

  // If env vars are missing, do not lock users out unexpectedly.
  if (!expectedUser || !expectedPass) {
    return;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorizedResponse();
  }

  let decoded = "";
  try {
    const encoded = authHeader.slice("Basic ".length).trim();
    decoded = atob(encoded);
  } catch {
    return unauthorizedResponse();
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) {
    return unauthorizedResponse();
  }

  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);
  if (user !== expectedUser || pass !== expectedPass) {
    return unauthorizedResponse();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
