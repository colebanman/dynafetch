package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"os"
	"strings"
	"sync"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

type rpcRequest struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type rpcResponse struct {
	ID     string    `json:"id"`
	Result any       `json:"result,omitempty"`
	Error  *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type workerSession struct {
	jar            tls_client.CookieJar
	browserProfile string
	timeoutSeconds int
	proxy          string
	client         tls_client.HttpClient
	clientMu       sync.Mutex
}

type openSessionParams struct {
	BrowserProfile string `json:"browserProfile,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
	Proxy          string `json:"proxy,omitempty"`
}

type closeSessionParams struct {
	SessionID string `json:"sessionId"`
}

type fetchRequest struct {
	Method      string            `json:"method"`
	URL         string            `json:"url"`
	Headers     map[string]string `json:"headers"`
	HeaderOrder []string          `json:"headerOrder,omitempty"`
	Body        string            `json:"body"`
	Proxy       string            `json:"proxy,omitempty"`
}

type fetchParams struct {
	SessionID      string       `json:"sessionId,omitempty"`
	Request        fetchRequest `json:"request"`
	FollowRedirect bool         `json:"followRedirect,omitempty"`
	MaxRedirects   int          `json:"maxRedirects,omitempty"`
	BrowserProfile string       `json:"browserProfile,omitempty"`
	TimeoutSeconds int          `json:"timeoutSeconds,omitempty"`
}

type batchFetchParams struct {
	SessionID      string         `json:"sessionId,omitempty"`
	Requests       []fetchRequest `json:"requests"`
	FollowRedirect bool           `json:"followRedirect,omitempty"`
	MaxRedirects   int            `json:"maxRedirects,omitempty"`
	BrowserProfile string         `json:"browserProfile,omitempty"`
	TimeoutSeconds int            `json:"timeoutSeconds,omitempty"`
}

type fetchResponse struct {
	Status   int               `json:"status"`
	Body     string            `json:"body"`
	Headers  map[string]string `json:"headers"`
	FinalURL string            `json:"finalUrl,omitempty"`
	Error    string            `json:"error,omitempty"`
	Retried  bool              `json:"retried,omitempty"`
}

type openSessionResult struct {
	SessionID string `json:"sessionId"`
}

var chrome146HeaderOrder = []string{
	"host",
	"accept",
	"accept-language",
	"cache-control",
	"pragma",
	"priority",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"upgrade-insecure-requests",
	"user-agent",
	"sec-fetch-site",
	"sec-fetch-mode",
	"sec-fetch-user",
	"sec-fetch-dest",
	"accept-encoding",
}

type workerState struct {
	mu       sync.RWMutex
	sessions map[string]*workerSession
}

func newWorkerState() *workerState {
	return &workerState{
		sessions: map[string]*workerSession{},
	}
}

func (s *workerState) openSession(params openSessionParams) openSessionResult {
	id := randomID()
	session := &workerSession{
		jar:            tls_client.NewCookieJar(),
		browserProfile: normalizeProfile(params.BrowserProfile),
		timeoutSeconds: normalizeTimeout(params.TimeoutSeconds),
		proxy:          normalizeProxy(params.Proxy),
	}

	s.mu.Lock()
	s.sessions[id] = session
	s.mu.Unlock()

	return openSessionResult{SessionID: id}
}

func (s *workerState) getSession(id string) (*workerSession, bool) {
	if strings.TrimSpace(id) == "" {
		return nil, false
	}
	s.mu.RLock()
	session, ok := s.sessions[id]
	s.mu.RUnlock()
	return session, ok
}

func (s *workerState) closeSession(id string) {
	if strings.TrimSpace(id) == "" {
		return
	}
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "session-fallback"
	}
	return hex.EncodeToString(b[:])
}

func normalizeProfile(profile string) string {
	profile = strings.TrimSpace(profile)
	if profile == "" {
		return "chrome_146"
	}
	return profile
}

func normalizeTimeout(timeout int) int {
	if timeout <= 0 {
		return 30
	}
	if timeout > 180 {
		return 180
	}
	return timeout
}

func normalizeProxy(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if strings.Contains(s, "://") {
		return s
	}
	parts := strings.Split(s, ":")
	if len(parts) == 4 {
		host, port, user, pass := parts[0], parts[1], parts[2], parts[3]
		if host != "" && port != "" && user != "" && pass != "" {
			return "http://" + user + ":" + pass + "@" + host + ":" + port
		}
	}
	if strings.Contains(s, "@") {
		return "http://" + s
	}
	return "http://" + s
}

func profileByName(name string) profiles.ClientProfile {
	if profile, ok := profiles.MappedTLSClients[name]; ok {
		return profile
	}
	return profiles.Chrome_146
}

func applyChrome146Defaults(req *fetchRequest) {
	if req.Headers == nil {
		req.Headers = map[string]string{}
	}

	defaults := map[string]string{
		"accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
		"accept-language":           "en-US,en;q=0.9",
		"accept-encoding":           "gzip, deflate, br",
		"cache-control":             "max-age=0",
		"pragma":                    "no-cache",
		"priority":                  "u=0, i",
		"sec-ch-ua":                 `"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"`,
		"sec-ch-ua-mobile":          "?0",
		"sec-ch-ua-platform":        `"macOS"`,
		"upgrade-insecure-requests": "1",
		"user-agent":                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		"sec-fetch-site":            "none",
		"sec-fetch-mode":            "navigate",
		"sec-fetch-user":            "?1",
		"sec-fetch-dest":            "document",
	}

	for k, v := range defaults {
		if strings.TrimSpace(req.Headers[k]) == "" {
			req.Headers[k] = v
		}
	}

	if len(req.HeaderOrder) == 0 {
		req.HeaderOrder = append([]string(nil), chrome146HeaderOrder...)
	}
}

func getOrCreateClient(session *workerSession, params fetchParams) (tls_client.HttpClient, error) {
	timeoutSeconds := normalizeTimeout(params.TimeoutSeconds)
	if session != nil && params.TimeoutSeconds <= 0 {
		timeoutSeconds = session.timeoutSeconds
	}

	browserProfile := normalizeProfile(params.BrowserProfile)
	if session != nil && strings.TrimSpace(params.BrowserProfile) == "" {
		browserProfile = session.browserProfile
	}

	proxy := normalizeProxy(params.Request.Proxy)
	if proxy == "" && session != nil {
		proxy = session.proxy
	}

	// Reuse the session client when possible (same profile/timeout/proxy).
	if session != nil {
		session.clientMu.Lock()
		defer session.clientMu.Unlock()

		if session.client != nil {
			// Session client exists — reuse it.
			return session.client, nil
		}

		client, err := tls_client.NewHttpClient(
			tls_client.NewNoopLogger(),
			tls_client.WithTimeoutSeconds(timeoutSeconds),
			tls_client.WithClientProfile(profileByName(browserProfile)),
			tls_client.WithRandomTLSExtensionOrder(),
			tls_client.WithNotFollowRedirects(),
			tls_client.WithCookieJar(session.jar),
		)
		if err != nil {
			return nil, err
		}
		if proxy != "" {
			if err := client.SetProxy(proxy); err != nil {
				return nil, err
			}
		}
		session.client = client
		return client, nil
	}

	// No session — create a one-off client.
	client, err := tls_client.NewHttpClient(
		tls_client.NewNoopLogger(),
		tls_client.WithTimeoutSeconds(timeoutSeconds),
		tls_client.WithClientProfile(profileByName(browserProfile)),
		tls_client.WithRandomTLSExtensionOrder(),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithCookieJar(tls_client.NewCookieJar()),
	)
	if err != nil {
		return nil, err
	}
	if proxy != "" {
		if err := client.SetProxy(proxy); err != nil {
			return nil, err
		}
	}
	return client, nil
}

func executeFetch(session *workerSession, params fetchParams) fetchResponse {
	req := params.Request
	applyChrome146Defaults(&req)

	client, err := getOrCreateClient(session, params)
	if err != nil {
		return fetchResponse{Status: 0, Headers: map[string]string{}, Error: "client init: " + err.Error()}
	}

	maxRedirects := params.MaxRedirects
	if maxRedirects <= 0 {
		maxRedirects = 5
	}
	followRedirects := params.FollowRedirect

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = "GET"
	}

	currentURL := req.URL
	currentMethod := method
	currentBody := req.Body

	for redirectCount := 0; ; redirectCount++ {
		httpReq, err := fhttp.NewRequest(currentMethod, currentURL, strings.NewReader(currentBody))
		if err != nil {
			return fetchResponse{Status: 0, Headers: map[string]string{}, Error: "bad request: " + err.Error()}
		}

		for k, v := range req.Headers {
			if k == "" || v == "" {
				continue
			}
			httpReq.Header.Set(k, v)
		}

		if len(req.HeaderOrder) > 0 {
			lowered := make([]string, 0, len(req.HeaderOrder))
			for _, h := range req.HeaderOrder {
				h = strings.TrimSpace(h)
				if h == "" {
					continue
				}
				lowered = append(lowered, strings.ToLower(h))
			}
			if len(lowered) > 0 {
				httpReq.Header[fhttp.HeaderOrderKey] = lowered
			}
		}

		resp, err := client.Do(httpReq)
		if err != nil {
			return fetchResponse{Status: 0, Headers: map[string]string{}, Error: err.Error(), FinalURL: currentURL}
		}

		bodyBytes, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			return fetchResponse{Status: resp.StatusCode, Headers: map[string]string{}, Error: readErr.Error(), FinalURL: currentURL}
		}

		headers := map[string]string{}
		for k, vv := range resp.Header {
			if len(vv) == 0 {
				continue
			}
			headers[k] = strings.Join(vv, "\n")
		}

		if followRedirects && resp.StatusCode >= 300 && resp.StatusCode < 400 && redirectCount < maxRedirects {
			location := headers["Location"]
			if location == "" {
				location = headers["location"]
			}
			if location != "" {
				nextURL, err := resolveLocation(currentURL, location)
				if err == nil {
					currentURL = nextURL
					if resp.StatusCode == 302 || resp.StatusCode == 303 {
						currentMethod = "GET"
						currentBody = ""
					}
					continue
				}
			}
		}

		return fetchResponse{
			Status:   resp.StatusCode,
			Body:     string(bodyBytes),
			Headers:  headers,
			FinalURL: currentURL,
		}
	}
}

func cookieJarForSession(session *workerSession) tls_client.CookieJar {
	if session != nil && session.jar != nil {
		return session.jar
	}
	return tls_client.NewCookieJar()
}

func resolveLocation(baseURL string, location string) (string, error) {
	baseReq, err := fhttp.NewRequest("GET", baseURL, nil)
	if err != nil {
		return "", err
	}
	u, err := baseReq.URL.Parse(location)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func decodeParams[T any](raw json.RawMessage) (T, error) {
	var out T
	if len(raw) == 0 {
		return out, nil
	}
	err := json.Unmarshal(raw, &out)
	return out, err
}

func respondError(writer *bufio.Writer, id string, code string, message string) error {
	return writeResponse(writer, rpcResponse{
		ID:    id,
		Error: &rpcError{Code: code, Message: message},
	})
}

func writeResponse(writer *bufio.Writer, resp rpcResponse) error {
	b, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	if _, err := writer.Write(append(b, '\n')); err != nil {
		return err
	}
	return writer.Flush()
}

func handleRPC(state *workerState, writer *bufio.Writer, req rpcRequest) error {
	switch req.Method {
	case "health":
		return writeResponse(writer, rpcResponse{
			ID: req.ID,
			Result: map[string]any{
				"ok":      true,
				"service": "dynafetch-net",
			},
		})
	case "openSession":
		params, err := decodeParams[openSessionParams](req.Params)
		if err != nil {
			return respondError(writer, req.ID, "bad_params", err.Error())
		}
		return writeResponse(writer, rpcResponse{ID: req.ID, Result: state.openSession(params)})
	case "closeSession":
		params, err := decodeParams[closeSessionParams](req.Params)
		if err != nil {
			return respondError(writer, req.ID, "bad_params", err.Error())
		}
		state.closeSession(params.SessionID)
		return writeResponse(writer, rpcResponse{ID: req.ID, Result: map[string]any{"ok": true}})
	case "fetch":
		params, err := decodeParams[fetchParams](req.Params)
		if err != nil {
			return respondError(writer, req.ID, "bad_params", err.Error())
		}
		session, ok := state.getSession(params.SessionID)
		if strings.TrimSpace(params.SessionID) != "" && !ok {
			return respondError(writer, req.ID, "session_not_found", "session not found")
		}
		return writeResponse(writer, rpcResponse{ID: req.ID, Result: executeFetch(session, params)})
	case "batchFetch":
		params, err := decodeParams[batchFetchParams](req.Params)
		if err != nil {
			return respondError(writer, req.ID, "bad_params", err.Error())
		}
		session, ok := state.getSession(params.SessionID)
		if strings.TrimSpace(params.SessionID) != "" && !ok {
			return respondError(writer, req.ID, "session_not_found", "session not found")
		}
		results := make([]fetchResponse, len(params.Requests))
		var wg sync.WaitGroup
		wg.Add(len(params.Requests))
		for i, request := range params.Requests {
			go func(idx int, req fetchRequest) {
				defer wg.Done()
				results[idx] = executeFetch(session, fetchParams{
					Request:        req,
					FollowRedirect: params.FollowRedirect,
					MaxRedirects:   params.MaxRedirects,
					BrowserProfile: params.BrowserProfile,
					TimeoutSeconds: params.TimeoutSeconds,
				})
			}(i, request)
		}
		wg.Wait()
		return writeResponse(writer, rpcResponse{ID: req.ID, Result: results})
	default:
		return respondError(writer, req.ID, "method_not_found", "unknown method")
	}
}

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

	state := newWorkerState()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)

	var writerMu sync.Mutex
	writer := bufio.NewWriter(os.Stdout)

	// lockedHandleRPC wraps handleRPC so the writer is mutex-protected,
	// allowing concurrent goroutines to safely write responses.
	lockedHandleRPC := func(req rpcRequest) {
		writerMu.Lock()
		defer writerMu.Unlock()
		if err := handleRPC(state, writer, req); err != nil {
			log.Printf("write response failed: %v", err)
		}
	}

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var req rpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			writerMu.Lock()
			_ = respondError(writer, "", "bad_request", err.Error())
			writerMu.Unlock()
			continue
		}

		if req.ID == "" {
			req.ID = randomID()
		}

		// Handle fetch/batchFetch concurrently; serialize session/health ops.
		switch req.Method {
		case "fetch", "batchFetch":
			go lockedHandleRPC(req)
		default:
			writerMu.Lock()
			if err := handleRPC(state, writer, req); err != nil {
				log.Printf("write response failed: %v", err)
				writerMu.Unlock()
				return
			}
			writerMu.Unlock()
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("scanner error: %v", err)
	}
}
