# Contributing to fyutr-connect

Thank you for your interest in contributing to **fyutr-connect**! This project provides schedule integrations for Malaysian universities, powering the [Fyutr](https://fyutr.app/download) student timetable app.

---

## Table of Contents

- [Adding a New Institution Integration](#adding-a-new-institution-integration)
- [Schema Reference](#schema-reference)
- [Scraper Rules](#scraper-rules)
- [Route Convention](#route-convention)
- [Institutional Variations](#handling-institutional-variations)
- [Submitting Your Contribution](#submitting-your-contribution)

---

## Adding a New Institution Integration

Each integration lives in its own directory:

```
src/institution/<institution-id>/
  scraper.ts   # Authentication + scraping logic
  route.ts     # Hono route definition
```

Create both files following the conventions below.

---

## Schema Reference

All institution scrapers **must** return the following TypeScript types. These are the canonical output interfaces that Fyutr consumes.

### `TimeSlot`

Represents a single recurring weekly class session.

```ts
interface TimeSlot {
  day: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  start: string; // "HH:MM" in 24-hour format, e.g. "08:00"
  end: string; // "HH:MM" in 24-hour format, e.g. "10:00"
}
```

### `Schedule`

Represents a single enrolled subject/course for a given semester.

```ts
interface Schedule {
  code: string; // Subject/course code, e.g. "CSCI1234"
  title: string; // Full subject name
  creditHours: number | null; // Credit hours, or null if unavailable
  section: string | number | null; // Class section/group identifier, or null
  instructor: string | null; // Lecturer name(s), or null if TBD
  location: string | null; // Venue/room, or null if unknown
  timeSlots: TimeSlot[]; // All weekly time slots for this subject
}
```

> **Note on `section`:** Naming conventions differ across universities. IIUM calls these "sections" (numeric), UiTM calls them "groups" (may be a string code). Use whatever the institution's system provides — the field accepts `string | number | null`.

### `SemesterCalendar`

A wrapper grouping schedules under a named academic semester.

```ts
interface SemesterCalendar {
  title: string | null; // Semester label, e.g. "2024/2025 Semester 1". Null if unknown.
  schedules: Schedule[];
}
```

### Scraper Return Type

Your `scrape()` method **must** be async and return `Promise<SemesterCalendar[]>`.

```ts
class MyScraper {
  async scrape(
    studentId: string,
    password: string,
  ): Promise<SemesterCalendar[]> {
    // ...
  }
}
```

### Example Output

```json
{
  "calendars": [
    {
      "title": "2024/2025 Semester 1",
      "schedules": [
        {
          "code": "CSCI1234",
          "title": "Introduction to Computing",
          "creditHours": 3,
          "section": 2,
          "instructor": "Dr. Ahmad bin Ali",
          "location": "Block A, Room 101",
          "timeSlots": [
            { "day": 1, "start": "08:00", "end": "10:00" },
            { "day": 3, "start": "08:00", "end": "10:00" }
          ]
        }
      ]
    }
  ]
}
```

---

## Scraper Rules

These rules are **strictly enforced** to maintain performance on Cloudflare Workers (CPU time limits apply).

### ✅ Required

- Use **native `fetch()`** for all HTTP requests.
- Use **regular expressions (`RegExp`)** for HTML/XML parsing.
- Return data strictly conforming to the [Schema Reference](#schema-reference).
- Throw an error with `"Login failed"` in the message string when credentials are invalid — the route handler checks for this string to return a proper `401`.
- Normalize times to `"HH:MM"` (24-hour) format.
- Normalize days to integers `0–6` (Sunday = 0).

### ❌ Forbidden

| Library                     | Reason                                   |
| --------------------------- | ---------------------------------------- |
| `puppeteer` / `playwright`  | Too heavy; not supported on Workers      |
| `cheerio` / `jsdom`         | DOM overhead on CPU-limited environments |
| `beautifulsoup`             | Python only                              |
| Any HTML/XML parser library | Use regex instead                        |

### Tips for Regex Parsing

- Strip HTML tags with `content.replace(/<[^>]*>/g, "")`.
- Decode common HTML entities manually (see `decodeHtml` in `iium/scraper.ts`).
- Use named capture groups for clarity: `/name="execution"\s+value="(?<token>[^"]+)"/`.
- Handle multi-slot courses (e.g., lab + lecture) by appending to `timeSlots[]`.
- Deduplicate time slots when iterating over date-keyed JSON (see `uitm/scraper.ts`).

---

## Route Convention

Every institution route follows the same template:

```ts
// src/institution/<id>/route.ts
import { Hono } from "hono";
import { z } from "zod";
import { MyScraper } from "./scraper";
import { success, fail } from "../../utils/response";

const myRoute = new Hono();

const loginSchema = z.object({
  studentId: z.string().min(1, "Student ID is required"),
  password: z.string().min(1, "Password is required"),
});

myRoute.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return fail(
        c,
        "VALIDATION_ERROR",
        "Invalid input",
        400,
        result.error.format(),
      );
    }

    const { studentId, password } = result.data;
    const scraper = new MyScraper();

    try {
      const calendars = await scraper.scrape(studentId, password);
      return success(c, { calendars });
    } catch (error: any) {
      if (error.message.includes("Login failed")) {
        return fail(c, "INVALID_CREDENTIALS", error.message, 401);
      }
      return fail(c, "INTERNAL_SERVER_ERROR", error.message, 500);
    }
  } catch (error: any) {
    return fail(c, "BAD_REQUEST", "Invalid JSON body", 400);
  }
});

export { myRoute };
```

Then register your route in `src/index.ts`:

```ts
import { myRoute } from "./institution/<id>/route";
app.route("/institution/<id>", myRoute);
```

---

## Handling Institutional Variations

Not all universities expose the same fields or structure data the same way. Some known variations:

| Field          | IIUM                        | IIC                        | UiTM                                  |
| -------------- | --------------------------- | -------------------------- | ------------------------------------- |
| `section`      | Numeric integer             | `null` (no section in API) | String group code (e.g. `"RCS2414A"`) |
| Multi-semester | Yes (all semesters fetched) | No (current only)          | No (current only, from CDN)           |
| Auth method    | CAS ticket flow             | Maestro RMI XML            | ECR iStudent portal POST              |
| Data source    | HTML table (regex)          | Proprietary XML (regex)    | CDN-hosted JSON                       |

If your institution's portal:

- **Has no concept of sections** → set `section: null`
- **Uses a different semester format** → use whatever string the portal provides as `title`
- **Only exposes the current semester** → return a single-element `SemesterCalendar[]`
- **Has extra metadata** (e.g., programme, faculty) → you may include them in `location` or `instructor` strings, but do not add extra fields to the schema

The Fyutr core team will apply any necessary normalization tweaks after your PR is merged.

---

## Submitting Your Contribution

1. **Fork** the repository at [Forthify/fyutr-connect](https://github.com/Forthify/fyutr-connect).
2. **Create a branch**: `feat/institution-<id>` (e.g. `feat/institution-utm`).
3. **Add your files**: `src/institution/<id>/scraper.ts` and `src/institution/<id>/route.ts`.
4. **Register your route** in `src/index.ts`.
5. **Add the institution logo** to `public/logos/`. Use an ID-based filename (e.g., `utm.png`).
6. **Open a Pull Request** with:
   - The institution name and student portal URL.
   - A brief description of the authentication flow.
   - A sample (redacted) API response.
7. Add your institution and yourself as a contributor in `src/data/institutions.json`.

> By contributing, you agree that your code is licensed under the [GNU Affero General Public License v3.0](LICENSE.md).
