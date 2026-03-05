import * as cheerio from "cheerio";

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
    const $init = cheerio.load(initHtml);
    const execution = $init('input[name="execution"]').attr("value");
    if (!execution) throw new Error("Failed to get execution token");

    // 2. Login
    const loginBody = new URLSearchParams();
    loginBody.append("username", studentId);
    loginBody.append("password", password);
    loginBody.append("execution", execution);
    loginBody.append("_eventId", "submit");
    loginBody.append("geolocation", "");
    loginBody.append("submit", "LOGIN");

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
    const $main = cheerio.load(mainScheduleHtml);

    const semesterLinks = $main("ul.dropdown-menu li a[href*='?ses=']")
      .map((_, el) => {
        const href = $main(el).attr("href") || "";
        const url = new URL(href, scheduleUrl);
        return {
          ses: url.searchParams.get("ses"),
          sem: url.searchParams.get("sem"),
          title: $main(el).text().trim(),
        };
      })
      .get() as { ses: string | null; sem: string | null; title: string }[];

    const calendars: SemesterCalendar[] = [];
    const seenSems = new Set<string>();

    // Process current page first (the one we already fetched)
    const currentTitle = $main("h3")
      .text()
      .trim()
      .toLowerCase()
      .includes("schedule")
      ? $main("h3").text().trim().replace("Schedule", "").trim()
      : null;

    if (currentTitle) {
      calendars.push({
        title: currentTitle,
        schedules: this.parseScheduleTable(mainScheduleHtml),
      });
      seenSems.add(currentTitle);
    }

    // Concurrent fetching for all other semesters
    // We take inspiration from gomaluum's concurrent approach but adapted for JS Promises
    const otherSems = semesterLinks.filter((sem) => !seenSems.has(sem.title));

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

    // Sort calendars numerically/chronologically if possible, or just return as is
    return calendars;
  }

  private parseScheduleTable(html: string): Schedule[] {
    const $ = cheerio.load(html);
    const schedules: Schedule[] = [];
    const table = $("table.table-hover");

    table.find("tbody tr, tr").each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length === 0) return; // Header or empty row

      // New course row (9 columns)
      if (tds.length === 9) {
        const code = $(tds[0]).text().trim();
        const title = $(tds[1]).text().trim();
        const sect = parseInt($(tds[2]).text().trim());
        const chr = parseFloat($(tds[3]).text().trim());
        const dayStr = $(tds[5]).text().trim();
        const timeStr = $(tds[6]).text().trim();
        const venue = $(tds[7]).text().trim();
        const lecturer = $(tds[8]).text().trim();

        const timeSlots: TimeSlot[] = [];
        if (dayStr && timeStr && timeStr.includes("-")) {
          const [start, end] = timeStr.split("-").map((t) => t.trim());
          if (start && end) {
            const days = this.mapDays(dayStr);
            days.forEach((day) => {
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
      }
      // Additional time slots for the previous course (4 columns)
      // This happens when a course has multiple venues or days (rowspan)
      else if (tds.length === 4 && schedules.length > 0) {
        const lastSchedule = schedules[schedules.length - 1];
        const dayStr = $(tds[0]).text().trim();
        const timeStr = $(tds[1]).text().trim();
        const venue = $(tds[2]).text().trim();
        const lecturer = $(tds[3]).text().trim();

        if (dayStr && timeStr && timeStr.includes("-")) {
          const [start, end] = timeStr.split("-").map((t) => t.trim());
          if (start && end) {
            const days = this.mapDays(dayStr);
            days.forEach((day) => {
              lastSchedule.timeSlots.push({
                day,
                start: this.parseTime(start),
                end: this.parseTime(end),
              });
            });
          }
        }

        // Handle venue and lecturer updates for subsequent rows
        if (
          venue &&
          lastSchedule.location &&
          !lastSchedule.location.includes(venue)
        ) {
          lastSchedule.location += `, ${venue}`;
        } else if (venue && !lastSchedule.location) {
          lastSchedule.location = venue;
        }

        if (lecturer && lecturer !== "TO BE DETERMINED") {
          if (
            lastSchedule.instructor &&
            !lastSchedule.instructor.includes(lecturer)
          ) {
            lastSchedule.instructor += `, ${lecturer}`;
          } else if (!lastSchedule.instructor) {
            lastSchedule.instructor = lecturer;
          }
        }
      }
    });

    return schedules;
  }
}
