# Plan 1: registration and onboarding — implementation plan

> **Historical.** This is one of the original build plans this codebase
> was built from — every step below has since shipped. It reflects the plan
> as scoped in August 2026, not necessarily today's implementation; for
> current architecture and conventions, see the repo's `CLAUDE.md` and the
> `planora-conventions` skill. Kept as a build-history record, not an active
> task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the frontend up to a state where a person opens the address in a browser, registers, lands inside in their own language and sees a meaningful empty state — instead of `{"detail":"Not Found"}`.

**Architecture:** Vite + React + TypeScript, built into static files served by Caddy in production and by Vite's dev server, proxying `/api` to the backend, in development. The interface is thin: it draws the state, sends requests and translates machine error codes into text in the reader's language. No date computations and no access decisions on the client — both live on the server.

**Tech Stack:** Vite, React, TypeScript, react-router, TanStack Query, Vitest, Testing Library, MSW. Our own CSS with variables, without a component library.

## Global Constraints

- Languages: `az` (by default), `en`, `ru`. One JSON dictionary per language, with meaningful keys (`auth.email_taken`) rather than phrases in one of the languages.
- A missing key falls back to Azerbaijani and writes a warning to the console rather than showing emptiness.
- Russian numerals demand real plural rules. `Intl.PluralRules` is used rather than "if 1 then день else дней".
- The user's content is never translated. Only the interface is.
- Case conversion is invariant only: `toLowerCase`, never `toLocaleLowerCase`. In the Azerbaijani locale `I` turns into `ı`, and everything that relies on case starts behaving differently for different people.
- The server answers with machine codes in `detail`. The client translates a code into text; showing a user a raw `detail` is forbidden.
- The session lives in an HTTP-only cookie. The client neither reads nor stores the token — it does not even know that it exists.
- The tests hit an intercepted network (MSW) rather than mocked application functions.
- Our own CSS with variables and dark-theme support through `prefers-color-scheme`.

---

### Task 1: The frontend's frame and the test harness

**Files:**
- Create: `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`
- Create: `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`
- Create: `frontend/src/styles.css`
- Create: `frontend/src/test/setup.ts`, `frontend/src/test/server.ts`
- Test: `frontend/src/App.test.tsx`

**Interfaces:**
- Produces: a buildable application; `npm test` runs Vitest; the dev server proxies `/api` to `http://localhost:8000`.

- [ ] **Step 1: Create the project**

```bash
cd /Users/me/Desktop/planora && npm create vite@latest frontend -- --template react-ts && cd frontend && npm install && npm install react-router-dom @tanstack/react-query && npm install -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom msw
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("рисует каркас приложения", () => {
    render(<App />);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and make sure it fails**

```bash
cd frontend && npx vitest run src/App.test.tsx
```

Expected: the `./App` module is not found, or Vitest is not configured.

- [ ] **Step 4: Configure Vite and Vitest**

`frontend/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // В разработке фронт и бэк живут на разных портах. Прокси избавляет от CORS
  // и заодно делает куку сессии однодоменной — иначе браузер её не сохранит.
  server: { proxy: { "/api": "http://localhost:8000" } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
});
```

`frontend/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

`onUnhandledRequest: "error"` was chosen deliberately: a request the test did not describe must fail the test rather than go silently nowhere.

`frontend/src/test/server.ts`:

```ts
import { setupServer } from "msw/node";

export const server = setupServer();
```

- [ ] **Step 5: Write the frame**

`frontend/src/App.tsx` — for now only markup with a `<main>`; the routing appears in task 5.

- [ ] **Step 6: Run the test**

```bash
cd frontend && npx vitest run
```

Expected: 1 passed.

- [ ] **Step 7: Make sure the build passes**

```bash
cd frontend && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add frontend/
git commit -m "feat: каркас фронтенда, прокси на бэкенд, тестовая оснастка"
```

---

### Task 2: Languages

**Files:**
- Create: `frontend/src/i18n/az.json`, `en.json`, `ru.json`
- Create: `frontend/src/i18n/index.ts`
- Test: `frontend/src/i18n/i18n.test.ts`

**Interfaces:**
- Produces: `t(key, params?) -> string`, `useLocale()`, `LocaleProvider`, `SUPPORTED_LOCALES`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import { translate } from "./index";

describe("переводы", () => {
  it("подставляет параметры", () => {
    expect(translate("ru", "auth.greeting", { name: "Алексей" })).toBe("Привет, Алексей");
  });

  it("склоняет русские числительные по настоящим правилам", () => {
    expect(translate("ru", "common.days", { count: 1 })).toBe("1 день");
    expect(translate("ru", "common.days", { count: 3 })).toBe("3 дня");
    expect(translate("ru", "common.days", { count: 5 })).toBe("5 дней");
    expect(translate("ru", "common.days", { count: 21 })).toBe("21 день");
    expect(translate("ru", "common.days", { count: 112 })).toBe("112 дней");
  });

  it("падает на азербайджанский, если ключа нет", () => {
    expect(translate("en", "missing.key.for.test")).toBe(translate("az", "missing.key.for.test"));
  });

  it("возвращает сам ключ, если его нет нигде", () => {
    expect(translate("en", "totally.unknown")).toBe("totally.unknown");
  });
});

describe("полнота словарей", () => {
  it("во всех языках один и тот же набор ключей", async () => {
    const [az, en, ru] = await Promise.all([
      import("./az.json"), import("./en.json"), import("./ru.json"),
    ]);
    const keys = (o: object) => Object.keys(flatten(o)).sort();
    expect(keys(en.default)).toEqual(keys(az.default));
    expect(keys(ru.default)).toEqual(keys(az.default));
  });
});
```

The last test is the very one the spec demands be kept in the tests rather than in people's eyes: without it the dictionaries' drift accumulates unnoticed.

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the module**

The key place is the plural. A string with a number is stored in the dictionary as an object with forms, and the form is chosen by `Intl.PluralRules`:

```ts
const PLURAL_RULES: Record<Locale, Intl.PluralRules> = {
  az: new Intl.PluralRules("az"),
  en: new Intl.PluralRules("en"),
  ru: new Intl.PluralRules("ru"),
};

function pick(value: unknown, locale: Locale, params?: Params): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && params && typeof params.count === "number") {
    const form = PLURAL_RULES[locale].select(params.count);
    const forms = value as Record<string, string>;
    return forms[form] ?? forms.other;
  }
  return undefined;
}
```

In `ru.json` the string looks like this, and it is the only honest way: Russian distinguishes three forms, and "if 1 then день else дней" is wrong for 2, 3, 4, 22 and onwards.

```json
{ "common": { "days": { "one": "{count} день", "few": "{count} дня", "many": "{count} дней" } } }
```

A missing key writes a `console.warn` and falls back to Azerbaijani.

- [ ] **Step 4: Fill the dictionaries with the strings this plan needs**

Registration, sign-in, the authentication errors, the header, the empty state. The keys are meaningful: `auth.register.title`, `auth.error.email_taken`, `nav.logout`.

- [ ] **Step 5: Implement the language context**

`LocaleProvider` determines the language on the first visit: it takes it from the profile if the person is signed in, otherwise from `navigator.language` if that asks for one of the three supported ones, otherwise Azerbaijani. The person's choice is saved and wins.

- [ ] **Step 6: Run the tests and commit**

```bash
cd frontend && npx vitest run
git add frontend/src/i18n/
git commit -m "feat: три языка со словарями и настоящими правилами числительных"
```

---

### Task 3: The API client and translating errors

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/auth.ts`
- Test: `frontend/src/api/client.test.ts`

**Interfaces:**
- Produces: `request<T>(path, init?) -> Promise<T>`; an `ApiError` class with a `code` field; `register()`, `login()`, `logout()`, `me()`.

- [ ] **Step 1: Write the failing tests**

```ts
it("превращает detail сервера в код ошибки, а не в текст для показа", async () => {
  server.use(http.post("/api/auth/register", () =>
    HttpResponse.json({ detail: "email_taken" }, { status: 409 })));

  await expect(register({ name: "A", email: "a@b.c", password: "s3cret-pass" }))
    .rejects.toMatchObject({ code: "email_taken", status: 409 });
});

it("отдаёт код валидации FastAPI отдельным классом", async () => {
  server.use(http.post("/api/auth/register", () =>
    HttpResponse.json({ detail: [{ loc: ["body", "password"], msg: "too short" }] },
      { status: 422 })));

  await expect(register({ name: "A", email: "a@b.c", password: "short" }))
    .rejects.toMatchObject({ code: "validation_error" });
});

it("не подставляет тело в сообщение пользователю", async () => {
  server.use(http.get("/api/auth/me", () =>
    HttpResponse.json({ detail: "session_expired" }, { status: 401 })));

  const error = await me().catch((e) => e);
  expect(error.code).toBe("session_expired");
  expect(error.message).not.toContain("session_expired");
});
```

The third test pins down the rule: `message` is for the developer's log, and only a translation by code may be shown to a person.

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the client**

Every request goes with `credentials: "include"`, because the session lives in a cookie. FastAPI has two error shapes: `detail` as a string is our machine code; `detail` as an array is a schema rejection, which we fold into a single `validation_error` code, because showing a person Pydantic's English prose on an Azerbaijani interface will not do.

- [ ] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/api
git add frontend/src/api/
git commit -m "feat: клиент API с машинными кодами ошибок"
```

---

### Task 4: The registration screen

**Files:**
- Create: `frontend/src/screens/Register.tsx`
- Create: `frontend/src/components/Field.tsx`
- Test: `frontend/src/screens/Register.test.tsx`

**Interfaces:**
- Produces: a screen with name, email and password fields; on success, a navigation into the application.

- [ ] **Step 1: Write the failing tests**

```tsx
it("регистрирует и уводит внутрь", async () => {
  server.use(http.post("/api/auth/register", () =>
    HttpResponse.json({ id: "u1", name: "Алексей", email: "a@b.c", locale: "az" },
      { status: 201 })));

  renderWithProviders(<Register />);
  await userEvent.type(screen.getByLabelText(/ad|name|имя/i), "Алексей");
  await userEvent.type(screen.getByLabelText(/e-?poçt|email|почта/i), "a@b.c");
  await userEvent.type(screen.getByLabelText(/parol|password|пароль/i), "s3cret-pass");
  await userEvent.click(screen.getByRole("button", { name: /qeydiyyat|register|зарегистр/i }));

  await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/projects"));
});

it("показывает занятый адрес переведённым текстом, а не кодом", async () => {
  server.use(http.post("/api/auth/register", () =>
    HttpResponse.json({ detail: "email_taken" }, { status: 409 })));

  renderWithProviders(<Register />, { locale: "ru" });
  await fillAndSubmit();

  expect(await screen.findByText("Этот адрес уже занят")).toBeInTheDocument();
  expect(screen.queryByText("email_taken")).not.toBeInTheDocument();
});

it("не отправляет форму с коротким паролем и объясняет почему", async () => {
  renderWithProviders(<Register />, { locale: "ru" });
  await userEvent.type(screen.getByLabelText(/пароль/i), "short");
  await userEvent.click(screen.getByRole("button", { name: /зарегистр/i }));

  expect(await screen.findByText(/не короче 8/i)).toBeInTheDocument();
});

it("сообщает о недоступности сервера, а не молчит", async () => {
  server.use(http.post("/api/auth/register", () => HttpResponse.error()));

  renderWithProviders(<Register />, { locale: "ru" });
  await fillAndSubmit();

  expect(await screen.findByText(/сервер недоступен/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the screen**

Requirements that are easy to miss: every field has a real `<label for>` rather than a placeholder instead of a caption — otherwise the screen is inaccessible to a screen reader and the tests above will not find the fields. The button is disabled for the duration of the request, so that a double click does not create two attempts. The password is checked for length before submitting — the server will check too, but there is no reason for a person to wait for an answer for the sake of something obvious.

- [ ] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/screens/Register.test.tsx
git add frontend/src/screens/Register.tsx frontend/src/components/Field.tsx frontend/src/screens/Register.test.tsx
git commit -m "feat: экран регистрации"
```

---

### Task 5: Sign-in, sign-out and protected routes

**Files:**
- Create: `frontend/src/screens/Login.tsx`
- Create: `frontend/src/auth/AuthProvider.tsx`
- Create: `frontend/src/auth/RequireAuth.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/auth/RequireAuth.test.tsx`, `frontend/src/screens/Login.test.tsx`

**Interfaces:**
- Produces: `useAuth() -> {user, status, login, logout}`; `RequireAuth` — a route wrapper; the `/login`, `/register`, `/projects` routes.

- [ ] **Step 1: Write the failing tests**

```tsx
it("не пускает неаутентифицированного и уводит на вход", async () => {
  server.use(http.get("/api/auth/me", () =>
    HttpResponse.json({ detail: "not_authenticated" }, { status: 401 })));

  renderApp({ route: "/projects" });

  expect(await screen.findByRole("heading", { name: /giriş|log in|вход/i })).toBeInTheDocument();
});

it("не мигает экраном входа, пока проверяет сессию", async () => {
  let resolve: (r: Response) => void;
  server.use(http.get("/api/auth/me", () => new Promise((r) => { resolve = r; })));

  renderApp({ route: "/projects" });

  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /вход/i })).not.toBeInTheDocument();
});

it("выход возвращает на экран входа и забывает пользователя", async () => {
  server.use(
    http.get("/api/auth/me", () => HttpResponse.json(USER)),
    http.post("/api/auth/logout", () => new HttpResponse(null, { status: 204 })),
  );

  renderApp({ route: "/projects" });
  await userEvent.click(await screen.findByRole("button", { name: /çıxış|log out|выйти/i }));

  expect(await screen.findByRole("heading", { name: /вход/i })).toBeInTheDocument();
});
```

The second test matters more than it seems: without a "checking" state a person sees a flash of the sign-in screen on every reload, even though they signed in long ago.

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the authentication provider**

Three states rather than two: `checking`, `authenticated`, `anonymous`. While `checking`, the route shows an indicator rather than deciding.

- [ ] **Step 4: Implement the sign-in screen and the routing**

- [ ] **Step 5: Run the tests and commit**

```bash
cd frontend && npx vitest run
git add frontend/src/auth/ frontend/src/screens/Login.tsx frontend/src/App.tsx
git commit -m "feat: вход, выход и защищённые маршруты"
```

---

### Task 6: The header, the language switcher and the empty state

**Files:**
- Create: `frontend/src/components/Header.tsx`
- Create: `frontend/src/screens/Projects.tsx`
- Test: `frontend/src/components/Header.test.tsx`, `frontend/src/screens/Projects.test.tsx`

**Interfaces:**
- Produces: a header with the organization's name, a language switcher and a sign-out; a projects list screen with an empty state.

This is the end of onboarding: the person is inside, sees their own name, can change the language and understands what to do next.

- [ ] **Step 1: Write the failing tests**

```tsx
it("переключение языка меняет интерфейс, но не данные", async () => {
  server.use(
    http.get("/api/auth/me", () => HttpResponse.json(USER)),
    http.get("/api/projects", () => HttpResponse.json([
      { id: "p1", name: "Şəhər Layihəsi", slug: "seher-layihesi" }])),
  );

  renderApp({ route: "/projects", locale: "ru" });
  expect(await screen.findByText("Проекты")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "AZ" }));

  expect(await screen.findByText("Layihələr")).toBeInTheDocument();
  // название проекта — содержимое пользователя, оно не переводится
  expect(screen.getByText("Şəhər Layihəsi")).toBeInTheDocument();
});

it("пустой список объясняет, что делать дальше", async () => {
  server.use(
    http.get("/api/auth/me", () => HttpResponse.json(USER)),
    http.get("/api/projects", () => HttpResponse.json([])),
  );

  renderApp({ route: "/projects", locale: "ru" });

  expect(await screen.findByText(/пока ни одного проекта/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /создать проект/i })).toBeInTheDocument();
});
```

The first test pins down the main language rule in one go: the chrome is translated, the content is not.

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the header and the screen**

The "create a project" button leads to a stub at this stage — the creation wizard itself appears in plan 2. But an empty state without a button would be a dead end, so the button is there.

- [ ] **Step 4: Styling**

`frontend/src/styles.css`: colour variables and a dark theme through `prefers-color-scheme`, as in the prototype. There is no need to carry the prototype's whole palette over — take only what this plan uses.

- [ ] **Step 5: Run the whole suite and build**

```bash
cd frontend && npx vitest run && npm run build
```

- [ ] **Step 6: Check it live against the real backend**

```bash
cd frontend && npm run dev
```

Walk the scenario by hand: register, see your own name in the header, switch the language, sign out, sign back in. Make sure the sign-in does not fall off after a page reload and that the sign-in screen does not flash.

- [ ] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat: шапка, переключатель языка, пустое состояние проектов"
```

---

### Task 7: Serving the frontend from Caddy

**Files:**
- Create: `Caddyfile`
- Create: `frontend/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: `docker compose up` serves the built interface at the root and proxies `/api` to the backend.

While the frontend lives only in the dev server, the "deploys with one command" promise is incomplete again — the root still gives a 404.

- [ ] **Step 1: Write the build Dockerfile**

Multi-stage: build the static files in a Node image, put the result into a Caddy image. The final image contains neither Node nor the sources.

- [ ] **Step 2: Write the Caddyfile**

The root serves the static files, `/api/*` is proxied to the `api` service. A fallback to `index.html` for the application's routes is mandatory — without it reloading the page on `/projects` gives a 404 from Caddy.

- [ ] **Step 3: Wire the service into compose and bring it up**

```bash
docker compose up -d --build && curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/
```

Expected: a 200 rather than a 404.

- [ ] **Step 4: Walk a live scenario through Caddy**

Open it in a browser, register, reload the page on an internal route and make sure it opens rather than giving a 404. This is a check of the fallback, and it cannot be replaced by a curl to the root.

- [ ] **Step 5: Update the README**

Add a section about the interface's address and about the frontend and the API living behind one domain.

- [ ] **Step 6: Commit**

```bash
git add Caddyfile frontend/Dockerfile docker-compose.yml README.md
git commit -m "feat: интерфейс отдаётся из Caddy на корне"
```

---

## What this plan does not do

- Creating projects, categories and tasks — plan 2. The button in the empty state leads to a stub.
- The chart — plan 2.
- Dragging, editing and the task card — plan 3.
- Password recovery and address confirmation — there is no plan; they will arrive together with mail in the invitations plan.
- The organization settings screen. The language is switched in the header; the other settings will appear when there is something to configure.
