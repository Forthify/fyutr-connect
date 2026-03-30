# fyutr-connect

**fyutr-connect** is the open-source integration layer that powers schedule scraping for [Fyutr](https://fyutr.app) — a timetable app for Malaysian university students.

This API is built on [Hono](https://hono.dev) and deployed on [Cloudflare Workers](https://workers.cloudflare.com). All scrapers use native `fetch()` and regular expressions — no third-party parsing libraries — to stay within Workers' CPU limits.

> Licensed under the [GNU Affero General Public License v3.0](LICENSE.md).

---

## Supported Institutions

| Institution | Portal                   | Status  |
| ----------- | ------------------------ | ------- |
| UiTM        | MyStudent (ECR iStudent) | ✅ Live |
| IIUM        | i-Ma'luum (CAS)          | ✅ Live |
| IIC         | Maestro CMS              | ✅ Live |

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) or Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Install & Run

```sh
bun install
bun run dev
```

### Deploy

```sh
bun run deploy
```

### Type Generation (Cloudflare Bindings)

```sh
bun run cf-typegen
```

---

## API Reference

All endpoints accept and return JSON. Responses follow this envelope:

```json
{
  "success": true,
  "data": { ... },
  "error": null
}
```

### `POST /institution/{id}`

Authenticate and retrieve a student's timetable.

**Request body:**

```json
{
  "studentId": "2022123456",
  "password": "yourpassword"
}
```

**Response (`200 OK`):**

```json
{
  "success": true,
  "data": {
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
  },
  "error": null
}
```

**Error codes:**

| Code                    | HTTP | Meaning                        |
| ----------------------- | ---- | ------------------------------ |
| `INVALID_CREDENTIALS`   | 401  | Wrong student ID or password   |
| `VALIDATION_ERROR`      | 400  | Missing/invalid request fields |
| `INTERNAL_SERVER_ERROR` | 500  | Scraping or network error      |

### `GET /contributors`

Returns all supported institutions with contributor metadata.

```json
{
  "success": true,
  "data": {
    "institutions": [
      {
        "id": "iium",
        "name": "International Islamic University Malaysia",
        "shortName": "IIUM",
        "integration": {
          "exists": true,
          "name": "i-Ma'luum",
          "url": "/institution/iium"
        },
        "contributors": [
          {
            "name": "Luqman Malik",
            "github": "lqmkim",
            "role": "author",
            "avatar": "https://avatars.githubusercontent.com/lqmkim"
          }
        ]
      }
    ]
  },
  "error": null
}
```

---

## Contributing

Want to add your university? Read [CONTRIBUTING.md](CONTRIBUTING.md) for the schema reference, scraper rules, and submission guide.
