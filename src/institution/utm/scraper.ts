export interface TimeSlot {
  day: number;
  start: string;
  end: string;
}

export interface Schedule {
  code: string;
  title: string;
  creditHours: number | null;
  section: string | number | null;
  instructor: string | null;
  location: string | null;
  timeSlots: TimeSlot[];
}

export interface SemesterCalendar {
  title: string | null;
  schedules: Schedule[];
}

export class UTMScraper {
  private cookies: string[] = [];
  private userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  private updateCookies(setCookie: string | null) {
    if (!setCookie) return;
    const newCookies = setCookie
      .split(/,(?=[^;]+=[^;]+)/)
      .map((c) => c.split(";")[0].trim());
    newCookies.forEach((nc) => {
      const name = nc.split("=")[0];
      this.cookies = this.cookies.filter((c) => !c.startsWith(name + "="));
      this.cookies.push(nc);
    });
  }

  private getCookieHeader() {
    return this.cookies.join("; ");
  }

  private mapDay(dayStr: string): number {
    return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(dayStr.toLowerCase());
  }

  /**
   * Convert 12-hour "08:00 AM" to 24-hour "HH:MM"
   */
  private parseTime(timeStr: string): string {
    const match = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return "00:00";

    let hours = parseInt(match[1], 10);
    const minutes = match[2];
    const ampm = match[3].toUpperCase();

    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;

    return `${hours.toString().padStart(2, "0")}:${minutes}`;
  }

  private decodeHtml(html: string): string {
    if (!html.includes("&")) return html;
    return html.replace(
      /&(amp|lt|gt|quot|#0?39|nbsp|copy|middot);/g,
      (match, entity) => {
        switch (entity) {
          case "amp":
            return "&";
          case "lt":
            return "<";
          case "gt":
            return ">";
          case "quot":
            return '"';
          case "#39":
          case "#039":
            return "'";
          case "nbsp":
            return " ";
          default:
            return match;
        }
      },
    );
  }

  /**
   * Login to a UTM Laravel portal (my.utm.my or studentportal.utm.my).
   * Both share the same UTMID credentials but have separate sessions.
   */
  private async loginToPortal(
    baseUrl: string,
    studentId: string,
    password: string,
  ): Promise<void> {
    const loginPageUrl = `${baseUrl}/login`;

    // GET login page → extract CSRF _token + session cookies
    const loginPageRes = await fetch(loginPageUrl, {
      headers: { "User-Agent": this.userAgent },
      redirect: "manual",
    });
    this.updateCookies(loginPageRes.headers.get("set-cookie"));

    let loginHtml = "";
    if (loginPageRes.status >= 300 && loginPageRes.status < 400) {
      const redirectUrl = loginPageRes.headers.get("location");
      if (redirectUrl) {
        const rUrl = redirectUrl.startsWith("http")
          ? redirectUrl
          : `${baseUrl}${redirectUrl}`;
        const redirectRes = await fetch(rUrl, {
          headers: {
            "User-Agent": this.userAgent,
            Cookie: this.getCookieHeader(),
          },
        });
        this.updateCookies(redirectRes.headers.get("set-cookie"));
        loginHtml = await redirectRes.text();
      }
    } else {
      loginHtml = await loginPageRes.text();
    }

    // Extract Laravel CSRF _token
    const tokenMatch =
      loginHtml.match(
        /name="_token"\s+(?:type="hidden"\s+)?value="([^"]+)"/,
      ) ||
      loginHtml.match(
        /value="([^"]+)"\s*(?:type="hidden"\s*)?name="_token"/,
      ) ||
      loginHtml.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);

    if (!tokenMatch) {
      throw new Error(
        "Login failed: Could not extract CSRF token from UTM login page.",
      );
    }

    // POST credentials
    // studentportal.utm.my uses "email", my.utm.my uses "username"
    const usesEmailField = loginHtml.includes('name="email"');
    const loginBody = new URLSearchParams();
    loginBody.set("_token", tokenMatch[1]);
    loginBody.set(usesEmailField ? "email" : "username", studentId);
    loginBody.set("password", password);

    const loginRes = await fetch(loginPageUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
        Cookie: this.getCookieHeader(),
        Referer: loginPageUrl,
        Origin: baseUrl,
      },
      body: loginBody.toString(),
      redirect: "manual",
    });

    this.updateCookies(loginRes.headers.get("set-cookie"));
    const loginRedirect = loginRes.headers.get("location");

    // Failed login → redirect back to /login or 422
    if (
      !loginRedirect ||
      loginRedirect.includes("/login") ||
      loginRes.status === 422
    ) {
      throw new Error(
        "Login failed: Invalid credentials. Please check your UTM ID and Password.",
      );
    }

    // Follow redirect to establish full session
    const nextUrl = loginRedirect.startsWith("http")
      ? loginRedirect
      : `${baseUrl}${loginRedirect}`;
    const nextRes = await fetch(nextUrl, {
      headers: {
        "User-Agent": this.userAgent,
        Cookie: this.getCookieHeader(),
      },
      redirect: "manual",
    });
    this.updateCookies(nextRes.headers.get("set-cookie"));
  }

  async scrape(
    studentId: string,
    password: string,
  ): Promise<SemesterCalendar[]> {
    // 1. Login directly to the student portal (separate session from my.utm.my)
    await this.loginToPortal(
      "https://studentportal.utm.my",
      studentId,
      password,
    );

    // 2. GET the timetable personalize page (semester dropdown)
    const timetableUrl = "https://studentportal.utm.my/timetablePersonalize";
    const timetableRes = await fetch(timetableUrl, {
      headers: {
        "User-Agent": this.userAgent,
        Cookie: this.getCookieHeader(),
      },
      redirect: "manual",
    });
    this.updateCookies(timetableRes.headers.get("set-cookie"));

    // If redirected, it means the session isn't valid
    if (timetableRes.status >= 300 && timetableRes.status < 400) {
      throw new Error(
        "Login failed: Session not established on student portal.",
      );
    }

    const timetableHtml = await timetableRes.text();

    if (timetableHtml.includes("STUDENTLogin") || timetableHtml.includes('name="username"')) {
      throw new Error("Login failed: Session not established on student portal.");
    }

    const semesterRegex = /<option\s+value="([^"]+)"[^>]*>([^<]*)<\/option>/g;
    const semesters: { id: string; title: string }[] = [];
    let match;
    while ((match = semesterRegex.exec(timetableHtml)) !== null) {
      const val = match[1].trim();
      if (val && /^\d+$/.test(val)) {
        semesters.push({ id: val, title: match[2].trim() || val });
      }
    }

    if (semesters.length === 0) {
      return [{ title: null, schedules: this.parseScheduleGrid(timetableHtml) }];
    }

    const calendars: SemesterCalendar[] = [];
    for (const sem of semesters) {
      try {
        const semUrl = `https://studentportal.utm.my/timetablePersonalizeSearch?semester=${sem.id}`;
        const res = await fetch(semUrl, {
          headers: {
            "User-Agent": this.userAgent,
            Cookie: this.getCookieHeader(),
          },
        });
        const html = await res.text();
        const schedules = this.parseScheduleGrid(html);

        if (schedules.length > 0) {
          calendars.push({ title: sem.title, schedules });
        }
      } catch (err) {
        console.error(`Failed to fetch UTM semester ${sem.title}:`, err);
      }
    }

    return calendars;
  }

  private parseScheduleGrid(html: string): Schedule[] {
    const tableMatch = html.match(/<table[^>]*class="[^"]*table-bordered[^"]*"[^>]*>([\s\S]*?)<\/table>/);
    if (!tableMatch) return [];

    const tableHtml = tableMatch[1];
    const theadMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
    if (!theadMatch) return [];

    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
    const timeSlots: { start: string; end: string }[] = [];
    let thMatch, isFirst = true;

    while ((thMatch = thRegex.exec(theadMatch[1])) !== null) {
      if (isFirst) { isFirst = false; continue; }
      const timeParts = this.decodeHtml(thMatch[1].replace(/<[^>]*>/g, "").trim()).split("-").map(t => t.trim());
      if (timeParts.length === 2) {
        timeSlots.push({ start: this.parseTime(timeParts[0]), end: this.parseTime(timeParts[1]) });
      }
    }

    if (timeSlots.length === 0) return [];

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const scheduleMap = new Map<string, Schedule>();

    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowContent = rowMatch[1];
      if (rowContent.includes("<th")) continue;

      const cells: string[] = [];
      let tdMatch;
      while ((tdMatch = tdRegex.exec(rowContent)) !== null) {
        cells.push(tdMatch[1]);
      }

      if (cells.length === 0) continue;

      // First cell = day name inside <span>
      const dayRaw = this.decodeHtml(cells[0].replace(/<[^>]*>/g, "").trim());
      const dayIndex = this.mapDay(dayRaw);
      if (dayIndex === -1) continue;

      // Remaining cells correspond to time slot columns
      for (let i = 1; i < cells.length; i++) {
        const slotIndex = i - 1;
        if (slotIndex >= timeSlots.length) break;

        const cellHtml = cells[i];
        // Strip all HTML tags, modal content, and normalize whitespace
        const cellText = this.decodeHtml(
          cellHtml
            .replace(/<div[^>]*class="[^"]*modal[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g, "")
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        );

        if (!cellText || cellText.length < 3) continue;

        // Parse "SBEZ1652 - EB1 B09 DK D" (after stripping HTML tags)
        const courseMatch = cellText.match(
          /^([A-Za-z0-9]+)\s*-\s*([A-Za-z0-9]+)\s+(.*)/,
        );

        let code = "";
        let section: string | null = null;
        let location: string | null = null;

        if (courseMatch) {
          code = courseMatch[1].trim();
          section = courseMatch[2].trim();
          // Clean location: strip modal text like "LOCATION ... Close" and map-pin
          let rawLoc = courseMatch[3]
            .replace(/\s*LOCATION[\s\S]*/i, "")
            .replace(/\s*Close\s*$/i, "")
            .replace(/\s*map-pin\s*/g, "")
            .trim();
          location = rawLoc || null;
        } else {
          // Fallback: extract course code
          const fallback = cellText.match(/([A-Za-z]{2,}[0-9]{3,})/);
          if (fallback) {
            code = fallback[1];
          } else {
            continue;
          }
        }

        const slot = timeSlots[slotIndex];
        const uniqueKey = `${code}-${section || ""}`;

        if (!scheduleMap.has(uniqueKey)) {
          scheduleMap.set(uniqueKey, {
            code,
            title: code, // Grid doesn't show full course title
            creditHours: null,
            section,
            instructor: null, // Not available in grid view
            location,
            timeSlots: [],
          });
        }

        const sched = scheduleMap.get(uniqueKey)!;

        // Merge consecutive time slots on the same day
        // UTM uses 50-min slots with 10-min gaps (e.g. 15:50 → 16:00)
        const existingSlot = sched.timeSlots.find(
          (t) => {
            if (t.day !== dayIndex) return false;
            // Check if slots are adjacent (exact match or 10-min gap)
            const endMinutes = parseInt(t.end.split(":")[0]) * 60 + parseInt(t.end.split(":")[1]);
            const startMinutes = parseInt(slot.start.split(":")[0]) * 60 + parseInt(slot.start.split(":")[1]);
            return startMinutes - endMinutes >= 0 && startMinutes - endMinutes <= 10;
          },
        );

        if (existingSlot) {
          existingSlot.end = slot.end;
        } else {
          const isDuplicate = sched.timeSlots.some(
            (t) =>
              t.day === dayIndex &&
              t.start === slot.start &&
              t.end === slot.end,
          );
          if (!isDuplicate) {
            sched.timeSlots.push({
              day: dayIndex,
              start: slot.start,
              end: slot.end,
            });
          }
        }

        if (location && !sched.location) {
          sched.location = location;
        }
      }
    }

    return Array.from(scheduleMap.values());
  }
}
