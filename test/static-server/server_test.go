// Behaviour tests for the generated static SPA server (Angular and React stacks).
//
// test/integration/static-server.test.js copies this file next to the generated
// main.go, go.mod and a zz_generated_config.go (runtime config field apiUrl <- API_URL,
// raw field retries <- RETRIES, served at /config.json) and runs `go test`.
package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Names are taken from real build output where noted; the rest follow each tool's
// documented [name]-[hash] / [name].[contenthash] templates.
func TestIsHashedName(t *testing.T) {
	hashed := []string{
		// Vite 8 (Rolldown), real output of test/fixtures/react-vite
		"index-arL1Nb1-.js", "index-BsnPf0Xs.css",
		// Vite 5-7 (Rollup 4, base64url hashes that may contain - and _)
		"index-BWoJ4fK0.js", "index-D-8a_Xyz.css", "react-dom-Cx3k_91-.js",
		"entry.client-CsQzVYfB.js", // React Router framework: no digit, mixed case
		"logo-BqF2lH0e.svg",
		// Vite 4 (Rollup 3, lowercase hex)
		"index-3d7d9bcf.js", "vendor-a1b2c3d4.css",
		// Angular application builder (esbuild, upper-case base32)
		"main-5ZKQ3LUR.js", "chunk-ABCDEFGH.js", "polyfills-FFHMD2TL.js", "styles-XYZ12345.css",
		"roboto-ABCD1234.woff2",
		// Create React App (webpack): [name].[contenthash:8], chunks, media with 20-hex hashes
		"main.8e3f1a2b.js", "787.1a2b3c4d.chunk.js", "main.073c9b0a.css", "logo.6ce24c58023cc2f8fd88.svg",
		// Angular's webpack builder: 16 or 20 hex
		"main.1a2b3c4d5e6f7a8b.js", "runtime.9f8e7d6c5b4a3a2b1c0d.js",
	}
	plain := []string{
		"favicon.ico", "logo.svg", "app.js", "styles.css", "vite.svg", "react.svg", "logo192.png",
		"apple-touch-icon.png", "android-chrome-192x192.png", "og-image-1200x630.png",
		"screenshot-1280x720.png", "icon-512x512-maskable.png", "inter-variable.woff2",
		"logo-on-white.svg", "logo-DarkMode.svg", "nav-Top-Menu.png", "btn-v2-large.png",
		"report-20240101.png", "jquery-3.7.1.min.js", "bootstrap.bundle.min.js", "file.deadbeef.js",
		"-.js", ".js", "a-.js",
	}
	for _, n := range hashed {
		if !isHashedName(n) {
			t.Errorf("%s should be recognised as content-hashed", n)
		}
	}
	for _, n := range plain {
		if isHashedName(n) {
			t.Errorf("%s must not be treated as content-hashed", n)
		}
	}
}

const indexHTML = "<!doctype html><html><head><title>fixture</title></head><body><div id=root></div></body></html>\n"

func newTestServer(t *testing.T) (*server, string) {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"index.html":                indexHTML,
		"assets/index-BWoJ4fK0.js":  strings.Repeat("console.log('hashed bundle');\n", 40),
		"assets/index-D-8a_Xyz.css": "body{margin:0}\n",
		"favicon.ico":               "icon",
		"logo.svg":                  "<svg xmlns='http://www.w3.org/2000/svg'/>",
		"robots.txt":                "User-agent: *\n",
		"config.json":               `{"apiUrl":"https://build.example.com","retries":1,"extra":"kept"}`,
		"docs/index.html":           "docs index\n",
		"assets/public-unhashed.js": "console.log('public');\n",
	}
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A file next to the web root that must never be reachable through it.
	if err := os.WriteFile(filepath.Join(filepath.Dir(root), "outside-secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := newServer(root)
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func do(s http.Handler, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func expect(t *testing.T, rec *httptest.ResponseRecorder, status int, cacheControl string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d, want %d (body %q)", rec.Code, status, rec.Body.String())
	}
	if cacheControl != "" && rec.Header().Get("Cache-Control") != cacheControl {
		t.Fatalf("Cache-Control %q, want %q", rec.Header().Get("Cache-Control"), cacheControl)
	}
}

const (
	immutable = "public, max-age=31536000, immutable"
	noStore   = "no-cache, no-store, must-revalidate"
)

func TestServing(t *testing.T) {
	s, _ := newTestServer(t)

	t.Run("healthz", func(t *testing.T) {
		rec := do(s, "GET", "/healthz", nil)
		expect(t, rec, 200, "no-store")
		if rec.Body.String() != "ok\n" {
			t.Fatalf("body %q", rec.Body.String())
		}
	})
	t.Run("index.html is never long-lived cached", func(t *testing.T) {
		rec := do(s, "GET", "/", nil)
		expect(t, rec, 200, noStore)
		if rec.Body.String() != indexHTML {
			t.Fatalf("body %q", rec.Body.String())
		}
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("Content-Type %q", rec.Header().Get("Content-Type"))
		}
	})
	t.Run("client routes fall back to index.html", func(t *testing.T) {
		for _, p := range []string{"/about", "/users/123", "/deep/route/", "/users/john.doe"} {
			rec := do(s, "GET", p, nil)
			expect(t, rec, 200, noStore)
			if rec.Body.String() != indexHTML {
				t.Fatalf("%s: body %q", p, rec.Body.String())
			}
		}
	})
	t.Run("directory index", func(t *testing.T) {
		rec := do(s, "GET", "/docs/", nil)
		expect(t, rec, 200, noStore)
		if rec.Body.String() != "docs index\n" {
			t.Fatalf("body %q", rec.Body.String())
		}
	})
	t.Run("hashed assets are immutable", func(t *testing.T) {
		expect(t, do(s, "GET", "/assets/index-BWoJ4fK0.js", nil), 200, immutable)
		expect(t, do(s, "GET", "/assets/index-D-8a_Xyz.css", nil), 200, immutable)
	})
	t.Run("unversioned assets are revalidated, not immutable", func(t *testing.T) {
		for _, p := range []string{"/favicon.ico", "/logo.svg", "/assets/public-unhashed.js"} {
			expect(t, do(s, "GET", p, nil), 200, "no-cache")
		}
	})
	t.Run("other files are not cached", func(t *testing.T) {
		expect(t, do(s, "GET", "/robots.txt", nil), 200, noStore)
	})
	t.Run("missing assets are a real 404, never the SPA fallback", func(t *testing.T) {
		for _, p := range []string{"/assets/missing-DEADBEEF.js", "/assets/index-AAAAAAAA.css", "/main-5ZKQ3LUR.js", "/missing.png"} {
			rec := do(s, "GET", p, nil)
			expect(t, rec, 404, "")
			if strings.Contains(rec.Body.String(), "<html") {
				t.Fatalf("%s: 404 body is index.html", p)
			}
		}
	})
	t.Run("HEAD", func(t *testing.T) {
		rec := do(s, "HEAD", "/", nil)
		expect(t, rec, 200, noStore)
		if rec.Body.Len() != 0 {
			t.Fatalf("HEAD returned a body of %d bytes", rec.Body.Len())
		}
	})
	t.Run("other methods are rejected", func(t *testing.T) {
		for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} {
			rec := do(s, m, "/", nil)
			expect(t, rec, 405, "")
			if rec.Header().Get("Allow") != "GET, HEAD" {
				t.Fatalf("%s: Allow %q", m, rec.Header().Get("Allow"))
			}
		}
	})
	t.Run("security headers on every response", func(t *testing.T) {
		for _, p := range []string{"/", "/healthz", "/assets/index-BWoJ4fK0.js", "/missing.png"} {
			rec := do(s, "GET", p, nil)
			for _, kv := range securityHeaders {
				if rec.Header().Get(kv[0]) != kv[1] {
					t.Fatalf("%s: %s = %q, want %q", p, kv[0], rec.Header().Get(kv[0]), kv[1])
				}
			}
		}
	})
	t.Run("gzip when accepted, identity otherwise", func(t *testing.T) {
		rec := do(s, "GET", "/assets/index-BWoJ4fK0.js", map[string]string{"Accept-Encoding": "gzip"})
		expect(t, rec, 200, immutable)
		if rec.Header().Get("Content-Encoding") != "gzip" || rec.Header().Get("Vary") != "Accept-Encoding" {
			t.Fatalf("Content-Encoding %q, Vary %q", rec.Header().Get("Content-Encoding"), rec.Header().Get("Vary"))
		}
		zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		plain, _ := io.ReadAll(zr)
		if !strings.Contains(string(plain), "hashed bundle") {
			t.Fatal("gzip body does not decode to the asset")
		}
		if do(s, "GET", "/assets/index-BWoJ4fK0.js", map[string]string{"Accept-Encoding": "gzip;q=0"}).Header().Get("Content-Encoding") != "" {
			t.Fatal("gzip;q=0 must not get gzip")
		}
	})
	t.Run("no traversal out of the web root", func(t *testing.T) {
		for _, p := range []string{"/../outside-secret.txt", "/%2e%2e/outside-secret.txt", "/assets/../../outside-secret.txt"} {
			rec := do(s, "GET", p, nil)
			if strings.Contains(rec.Body.String(), "secret") {
				t.Fatalf("%s served a file outside the web root", p)
			}
		}
	})
	t.Run("build-time config.json is served as a file, never cached", func(t *testing.T) {
		rec := do(s, "GET", "/config.json", nil)
		expect(t, rec, 200, noStore)
		if !strings.Contains(rec.Body.String(), "build.example.com") {
			t.Fatalf("body %q", rec.Body.String())
		}
	})
}

func TestRuntimeConfigFromEnv(t *testing.T) {
	t.Setenv("USE_RUNTIME_CONFIG", "true")
	t.Setenv("API_URL", "https://runtime.example.com")
	t.Setenv("RETRIES", "7")
	s, _ := newTestServer(t)
	rec := do(s, "GET", "/config.json", nil)
	expect(t, rec, 200, noStore)
	body := rec.Body.String()
	for _, want := range []string{`"apiUrl": "https://runtime.example.com"`, `"retries": 7`, `"extra": "kept"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("rendered config %q lacks %s", body, want)
		}
	}
}

func TestStartupNeedsIndexHTML(t *testing.T) {
	if _, err := newServer(t.TempDir()); err == nil {
		t.Fatal("a web root without index.html must fail at startup, not serve 404s")
	}
}
