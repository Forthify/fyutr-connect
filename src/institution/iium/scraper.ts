// Cheerio removed for performance reasons (CPU limit)

export interface TimeSlot {
  day: number;
  start: string;
  end: string;
}

export interface Schedule {
  code: string;
  title: string;
  creditHours: number | null;
  section: number | null;
  instructor: string | null;
  location: string | null;
  timeSlots: TimeSlot[];
}

export interface SemesterCalendar {
  title: string | null;
  schedules: Schedule[];
}

export class IIUMScraper {
  private cookies: string[] = [];
  private userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

  private mapDays(dayStr: string): number[] {
    const dayMap: Record<string, number> = {
      SUN: 0,
      SUNDAY: 0,
      MON: 1,
      MONDAY: 1,
      TUE: 2,
      TUESDAY: 2,
      WED: 3,
      WEDNESDAY: 3,
      THU: 4,
      THUR: 4,
      THURSDAY: 4,
      FRI: 5,
      FRIDAY: 5,
      SAT: 6,
      SATURDAY: 6,
      // Single/Double letter shorthand
      M: 1,
      T: 2,
      W: 3,
      R: 4,
      TH: 4,
      F: 5,
      S: 6,
      U: 0,
    };

    const comboMap: Record<string, string[]> = {
      MTW: ["M", "T", "W"],
      TWTH: ["T", "W", "TH"],
      MTWTH: ["M", "T", "W", "TH"],
      MTWTHF: ["M", "T", "W", "TH", "F"],
    };

    const cleaned = dayStr.trim().toUpperCase().replace(/\s+/g, "");

    // Check for predefined combinations first
    if (comboMap[cleaned]) {
      return comboMap[cleaned].map((d) => dayMap[d]);
    }

    // Handle formats like "M-W", "MON-WED", "M,W", or "MON,WED"
    // The user notes "M-W" is Monday AND Wednesday, not a range.
    const separators = /[-,\s/]+/;
    const parts = dayStr
      .split(separators)
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p.length > 0);

    // If it's a single string like "MW", we should also handle it char by char if they are single letters
    if (parts.length === 1 && parts[0].length > 1 && !dayMap[parts[0]]) {
      const chars = parts[0].split("");
      const result: number[] = [];
      for (const char of chars) {
        if (dayMap[char] !== undefined) {
          result.push(dayMap[char]);
        }
      }
      return result;
    }

    const result: number[] = [];
    for (const part of parts) {
      if (dayMap[part] !== undefined) {
        result.push(dayMap[part]);
      }
    }
    return result;
  }

  private parseTime(timeStr: string): string {
    // Input format: 0800, 1400, 830, etc.
    if (!timeStr || timeStr.trim() === "-" || timeStr.length < 3)
      return "00:00";
    let cleanTime = timeStr.replace(/\D/g, "");

    // Handle 3-digit times (e.g., 830 -> 0830)
    if (cleanTime.length === 3) {
      cleanTime = "0" + cleanTime;
    }

    if (cleanTime.length < 4) return "00:00";
    return `${cleanTime.substring(0, 2)}:${cleanTime.substring(2, 4)}`;
  }

  async scrape(
    studentId: string,
    password: string,
  ): Promise<SemesterCalendar[]> {
    // 1. Get execution token
    const casUrl =
      "https://cas.iium.edu.my:8448/cas/login?service=https://imaluum.iium.edu.my/home";
    const initRes = await fetch(casUrl, {
      headers: { "User-Agent": this.userAgent },
    });
    this.updateCookies(initRes.headers.get("set-cookie"));

    const initHtml = await initRes.text();
    const executionMatch = initHtml.match(/name="execution"\s+value="([^"]+)"/);
    if (!executionMatch) throw new Error("Failed to get execution token");
    const execution = executionMatch[1];

    // 2. Login
    const loginBody = new URLSearchParams();
    loginBody.set("username", studentId);
    loginBody.set("password", password);
    loginBody.set("execution", execution);
    loginBody.set("_eventId", "submit");
    loginBody.set("geolocation", "");
    loginBody.set("submit", "LOGIN");

    const loginRes = await fetch(casUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
        Cookie: this.getCookieHeader(),
      },
      body: loginBody.toString(),
      redirect: "manual",
    });

    this.updateCookies(loginRes.headers.get("set-cookie"));
    const ticketUrl = loginRes.headers.get("location");
    if (!ticketUrl || !ticketUrl.includes("ticket=")) {
      throw new Error(
        "Login failed: Invalid credentials or redirection. Please check your Student ID and Password.",
      );
    }

    // 3. Follow ticket to establish session in imaluum
    const ticketRes = await fetch(ticketUrl, {
      headers: { "User-Agent": this.userAgent, Cookie: this.getCookieHeader() },
      redirect: "manual",
    });
    this.updateCookies(ticketRes.headers.get("set-cookie"));

    // 4. Get main schedule page to find all semesters
    const scheduleUrl = "https://imaluum.iium.edu.my/MyAcademic/schedule";
    const mainScheduleRes = await fetch(scheduleUrl, {
      headers: { "User-Agent": this.userAgent, Cookie: this.getCookieHeader() },
    });
    const mainScheduleHtml = await mainScheduleRes.text();

    // Debug: Find all links with 'ses='
    const allLinksRegex =
      /<a[^>]+href="([^"]*?ses=[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let linkMatch;
    // Use Regex to find semester links
    // These are relative links like ?ses=2025/2026&sem=2
    const semesterRegex =
      /<a[^>]+href="(\?ses=([^&]+)&sem=([^"]+))"[^>]*>([\s\S]*?)<\/a>/g;
    const semesterLinks: { ses: string; sem: string; title: string }[] = [];
    let match;
    while ((match = semesterRegex.exec(mainScheduleHtml)) !== null) {
      const title = this.decodeHtml(
        match[4]
          .replace(/<[^>]*>/g, "")
          .trim()
          .replace(/\s+/g, " "),
      );
      semesterLinks.push({
        ses: match[2],
        sem: match[3],
        title,
      });
    }

    const calendars: SemesterCalendar[] = [];
    const seenSems = new Set<string>();

    // Process current page first (already fetched)
    const titleMatch = mainScheduleHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const currentTitleRaw = titleMatch
      ? this.decodeHtml(
          titleMatch[1]
            .replace(/<[^>]*>/g, "")
            .replace(/Schedule/i, "")
            .trim()
            .replace(/\s+/g, " "),
        )
      : null;

    // Normalize currentTitle for comparison
    const currentTitleNorm = currentTitleRaw?.toLowerCase() || "";

    if (currentTitleRaw) {
      calendars.push({
        title: currentTitleRaw,
        schedules: this.parseScheduleTable(mainScheduleHtml),
      });
      seenSems.add(currentTitleNorm);
    }

    // Concurrent fetching for other semesters
    // Ignore the one we just processed
    const otherSems = semesterLinks.filter((sem) => {
      const norm = sem.title.toLowerCase();
      if (seenSems.has(norm)) return false;
      seenSems.add(norm); // Avoid duplicate links in dropdown
      return true;
    });

    const fetchPromises = otherSems.map(async (sem) => {
      const semUrl = `https://imaluum.iium.edu.my/MyAcademic/schedule?ses=${sem.ses}&sem=${sem.sem}`;
      const res = await fetch(semUrl, {
        headers: {
          "User-Agent": this.userAgent,
          Cookie: this.getCookieHeader(),
        },
      });
      const html = await res.text();
      return {
        title: sem.title,
        schedules: this.parseScheduleTable(html),
      };
    });

    const results = await Promise.all(fetchPromises);
    calendars.push(...results);

    return calendars;
  }

  private decodeHtml(html: string): string {
    if (!html.includes("&")) return html;
    return html.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (match, entity) => {
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
          return "'";
        case "nbsp":
          return " ";
        default:
          return match;
      }
    });
  }

  private parseScheduleTable(html: string): Schedule[] {
    const schedules: Schedule[] = [];
    // Efficiently target the schedule table body
    const tableBodyMatch = html.match(
      /<table[^>]*class="[^"]*table-hover[^"]*"[^>]*>([\s\S]*?)<\/table>/,
    );
    if (!tableBodyMatch) return [];

    const tableBody = tableBodyMatch[1];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;

    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableBody)) !== null) {
      const cells: string[] = [];
      let cellMatch;
      const rowHtml = rowMatch[1];
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        // Strip HTML tags and entities
        cells.push(
          this.decodeHtml(cellMatch[1].replace(/<[^>]*>/g, "").trim()),
        );
      }

      if (cells.length === 0) continue;

      if (cells.length === 9) {
        const [
          code,
          title,
          sectStr,
          chrStr,
          _campus,
          dayStr,
          timeStr,
          venue,
          lecturer,
        ] = cells;
        const sect = parseInt(sectStr);
        const chr = parseFloat(chrStr);

        const timeSlots: TimeSlot[] = [];
        if (dayStr && timeStr && timeStr.includes("-")) {
          const [start, end] = timeStr.split("-").map((t) => t.trim());
          if (start && end) {
            this.mapDays(dayStr).forEach((day) => {
              timeSlots.push({
                day,
                start: this.parseTime(start),
                end: this.parseTime(end),
              });
            });
          }
        }

        schedules.push({
          code,
          title,
          section: isNaN(sect) ? null : sect,
          creditHours: isNaN(chr) ? null : chr,
          instructor: lecturer === "TO BE DETERMINED" ? null : lecturer,
          location: venue || null,
          timeSlots,
        });
      } else if (cells.length === 4 && schedules.length > 0) {
        // Additional slot for existing course
        const [dayStr, timeStr, venue, lecturer] = cells;
        const last = schedules[schedules.length - 1];

        if (dayStr && timeStr && timeStr.includes("-")) {
          const [start, end] = timeStr.split("-").map((t) => t.trim());
          if (start && end) {
            this.mapDays(dayStr).forEach((day) => {
              last.timeSlots.push({
                day,
                start: this.parseTime(start),
                end: this.parseTime(end),
              });
            });
          }
        }

        if (venue && last.location && !last.location.includes(venue)) {
          last.location += `, ${venue}`;
        } else if (venue && !last.location) {
          last.location = venue;
        }

        if (lecturer && lecturer !== "TO BE DETERMINED") {
          if (last.instructor && !last.instructor.includes(lecturer)) {
            last.instructor += `, ${lecturer}`;
          } else if (!last.instructor) {
            last.instructor = lecturer;
          }
        }
      }
    }

    return schedules;
  }
}
