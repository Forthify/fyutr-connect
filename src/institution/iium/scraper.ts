/* global fetch, URL, URLSearchParams */
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

  private mapDay(dayStr: string): number {
    const days: Record<string, number> = {
      SUN: 0,
      MON: 1,
      TUE: 2,
      WED: 3,
      THU: 4,
      FRI: 5,
      SAT: 6,
    };
    return days[dayStr.toUpperCase()] ?? 0;
  }

  private parseTime(timeStr: string): string {
    // Input format: 0800, 1400, etc.
    if (!timeStr || timeStr.length < 4) return "00:00";
    return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}`;
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
      throw new Error("Login failed: Invalid credentials or redirection");
    }

    // 3. Follow ticket
    const ticketRes = await fetch(ticketUrl, {
      headers: { "User-Agent": this.userAgent, Cookie: this.getCookieHeader() },
      redirect: "manual",
    });
    this.updateCookies(ticketRes.headers.get("set-cookie"));

    // 4. Get main schedule page to find semesters
    const scheduleUrl = "https://imaluum.iium.edu.my/MyAcademic/schedule";
    const mainScheduleRes = await fetch(scheduleUrl, {
      headers: { "User-Agent": this.userAgent, Cookie: this.getCookieHeader() },
    });
    const mainScheduleHtml = await mainScheduleRes.text();
    const $main = cheerio.load(mainScheduleHtml);

    const semesters = $main("ul.dropdown-menu li a[href*='?ses=']")
      .map((_, el) => {
        const href = $main(el).attr("href") || "";
        const url = new URL(href, scheduleUrl);
        return {
          ses: url.searchParams.get("ses"),
          sem: url.searchParams.get("sem"),
          title: $main(el).text().trim(),
        };
      })
      .get();

    // If no semesters found in dropdown, maybe only current one exists?
    // Let's also include the current page if it seems like a schedule
    const calendars: SemesterCalendar[] = [];

    // Deduplicate and process each semester
    const seenSems = new Set<string>();

    // Process current page first if it has a schedule
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

    for (const sem of semesters) {
      if (seenSems.has(sem.title)) continue;

      const semUrl = `https://imaluum.iium.edu.my/MyAcademic/schedule?ses=${sem.ses}&sem=${sem.sem}`;
      const semRes = await fetch(semUrl, {
        headers: {
          "User-Agent": this.userAgent,
          Cookie: this.getCookieHeader(),
        },
      });
      const semHtml = await semRes.text();

      calendars.push({
        title: sem.title,
        schedules: this.parseScheduleTable(semHtml),
      });
      seenSems.add(sem.title);
    }

    return calendars;
  }

  private parseScheduleTable(html: string): Schedule[] {
    const $ = cheerio.load(html);
    const schedules: Schedule[] = [];
    const table = $("table.table-hover");

    table.find("tbody tr, tr").each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length === 0) return; // Header or empty

      // If length is 9, it's a new course row
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
            timeSlots.push({
              day: this.mapDay(dayStr),
              start: this.parseTime(start),
              end: this.parseTime(end),
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
      // If length is 4, it's an additional time slot for the previous course
      // In iMaluum, it seems additional slots have 4 tds: day, time, venue, lecturer?
      // Wait, let's re-examine the snippet from Step 42
      /*
      <tr>
          <td rowspan="2">LMBD 2204</td>
          <td rowspan="2">BAHASA  MELAYU KERJAYA (SAINS DAN TEKNOLOGI)</td>
          <td rowspan="2">7</td>
          <td rowspan="2">2</td>
          <td rowspan="2">Registered</td>
                  <td>MON</td>
              <td>1600 - 1750</td>
              <td>ENG TR E0-3-36</td>
              <td>TO BE DETERMINED</td>
                                                                          </tr>
      <tr>
      <td>WED</td>
      <td>1600 - 1750</td>
      <td></td>
      <td>TO BE DETERMINED</td>
      </tr>
      */
      // The second <tr> has 4 <td> elements.
      else if (tds.length === 4 && schedules.length > 0) {
        const lastSchedule = schedules[schedules.length - 1];
        const dayStr = $(tds[0]).text().trim();
        const timeStr = $(tds[1]).text().trim();
        const venue = $(tds[2]).text().trim();
        const lecturer = $(tds[3]).text().trim();

        if (dayStr && timeStr && timeStr.includes("-")) {
          const [start, end] = timeStr.split("-").map((t) => t.trim());
          if (start && end) {
            lastSchedule.timeSlots.push({
              day: this.mapDay(dayStr),
              start: this.parseTime(start),
              end: this.parseTime(end),
            });
          }
        }

        // Append venue and lecturer if they are different and not null
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
