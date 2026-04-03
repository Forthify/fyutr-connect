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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TEACHER_MARKERS = [">Teacher<", ">Pengajar<", ">Lecturer<", "Non-editing teacher"];
const TEACHER_NAME_PATTERNS = [
  /class="userlink"[^>]*>([^<]+)<\/a>/i,
  /<th[^>]*class="(?:[^"]*\s)?c1(?:\s[^"]*)?"[^>]*>.*?<a[^>]*>([^<]+)<\/a>/is,
  /<th[^>]*>.*?<a[^>]*course=\d+[^>]*>([^<]+)<\/a>/is,
  /<a[^>]*href="[^"]*user\/profile\.php\?id=\d+[^"]*"[^>]*>([^<]+)<\/a>/i,
];

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function parseCookies(header: string | null, existing: string[]): string[] {
  if (!header) return existing;
  const result = [...existing];
  header.split(/,(?=[^;]+=[^;]+)/).map(c => c.split(";")[0].trim()).forEach(nc => {
    const name = nc.split("=")[0];
    const idx = result.findIndex(c => c.startsWith(name + "="));
    if (idx >= 0) result[idx] = nc;
    else result.push(nc);
  });
  return result;
}

function decodeHtml(html: string): string {
  if (!html.includes("&")) return html;
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#039": "'", nbsp: " " };
  return html.replace(/&(amp|lt|gt|quot|#0?39|nbsp|copy|middot);/g, (m, e) => entities[e] ?? m);
}

function parseTime(timeStr: string): string {
  const match = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return "00:00";
  let h = parseInt(match[1], 10);
  if (match[3].toUpperCase() === "PM" && h < 12) h += 12;
  if (match[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${h.toString().padStart(2, "0")}:${match[2]}`;
}

function extractTeacherName(rowText: string): string | null {
  if (!TEACHER_MARKERS.some(m => rowText.includes(m))) return null;
  for (const pat of TEACHER_NAME_PATTERNS) {
    const m = rowText.match(pat);
    if (m) return m[1].trim();
  }
  return null;
}

export class UTMScraper {
  private cookies: string[] = [];

  private updateCookies(header: string | null) {
    this.cookies = parseCookies(header, this.cookies);
  }

  private get cookieHeader() {
    return this.cookies.join("; ");
  }

  private headers(extra: Record<string, string> = {}) {
    return { "User-Agent": UA, Cookie: this.cookieHeader, ...extra };
  }

  private async loginToPortal(baseUrl: string, studentId: string, password: string): Promise<void> {
    const loginPageUrl = `${baseUrl}/login`;
    const loginPageRes = await fetch(loginPageUrl, { headers: { "User-Agent": UA }, redirect: "manual" });
    this.updateCookies(loginPageRes.headers.get("set-cookie"));

    let loginHtml = "";
    if (loginPageRes.status >= 300 && loginPageRes.status < 400) {
      const loc = loginPageRes.headers.get("location");
      if (loc) {
        const rUrl = loc.startsWith("http") ? loc : `${baseUrl}${loc}`;
        const r = await fetch(rUrl, { headers: this.headers() });
        this.updateCookies(r.headers.get("set-cookie"));
        loginHtml = await r.text();
      }
    } else {
      loginHtml = await loginPageRes.text();
    }

    const tokenMatch =
      loginHtml.match(/name="_token"\s+(?:type="hidden"\s+)?value="([^"]+)"/) ||
      loginHtml.match(/value="([^"]+)"\s*(?:type="hidden"\s*)?name="_token"/) ||
      loginHtml.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);

    if (!tokenMatch) throw new Error("Login failed: Could not extract CSRF token from UTM login page.");

    const usesEmail = loginHtml.includes('name="email"');
    const body = new URLSearchParams({ _token: tokenMatch[1], [usesEmail ? "email" : "username"]: studentId, password });

    const loginRes = await fetch(loginPageUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...this.headers(), Referer: loginPageUrl, Origin: baseUrl },
      body: body.toString(),
      redirect: "manual",
    });
    this.updateCookies(loginRes.headers.get("set-cookie"));

    const redirect = loginRes.headers.get("location");
    if (!redirect || redirect.includes("/login") || loginRes.status === 422) {
      throw new Error("Login failed: Invalid credentials. Please check your UTM ID and Password.");
    }

    const nextUrl = redirect.startsWith("http") ? redirect : `${baseUrl}${redirect}`;
    const nextRes = await fetch(nextUrl, { headers: this.headers(), redirect: "manual" });
    this.updateCookies(nextRes.headers.get("set-cookie"));
  }

  async scrape(studentId: string, password: string): Promise<SemesterCalendar[]> {
    await this.loginToPortal("https://studentportal.utm.my", studentId, password);

    const timetableRes = await fetch("https://studentportal.utm.my/timetablePersonalize", {
      headers: this.headers(), redirect: "manual",
    });
    this.updateCookies(timetableRes.headers.get("set-cookie"));

    if (timetableRes.status >= 300 && timetableRes.status < 400) {
      throw new Error("Login failed: Session not established on student portal.");
    }

    const timetableHtml = await timetableRes.text();
    if (timetableHtml.includes("STUDENTLogin") || timetableHtml.includes('name="username"')) {
      throw new Error("Login failed: Session not established on student portal.");
    }

    const semesters: { id: string; title: string }[] = [];
    let m;
    const semRe = /<option\s+value="([^"]+)"[^>]*>([^<]*)<\/option>/g;
    while ((m = semRe.exec(timetableHtml)) !== null) {
      const val = m[1].trim();
      if (val && /^\d+$/.test(val)) semesters.push({ id: val, title: m[2].trim() || val });
    }

    if (semesters.length === 0) {
      const calendars: SemesterCalendar[] = [];
      const reg = await this.fetchCourseRegistration();
      if (reg) calendars.push(reg);
      const grid = this.parseScheduleGrid(timetableHtml);
      if (grid.length > 0) calendars.push({ title: null, schedules: grid });
      return calendars;
    }

    // Fire all sources concurrently
    const currentRegPromise = this.fetchCourseRegistration();
    const semesterPromises = semesters.map(async (sem): Promise<SemesterCalendar | null> => {
      try {
        const res = await fetch(`https://studentportal.utm.my/timetablePersonalizeSearch?semester=${sem.id}`, { headers: this.headers() });
        const schedules = this.parseScheduleGrid(await res.text());
        return schedules.length > 0 ? { title: sem.title, schedules } : null;
      } catch { return null; }
    });

    const currentReg = await currentRegPromise;
    const elearningPromise = currentReg ? this.fetchElearningInstructors(currentReg, studentId, password) : Promise.resolve();
    const [semResults] = await Promise.all([Promise.all(semesterPromises), elearningPromise]);

    const calendars: SemesterCalendar[] = [];
    if (currentReg) calendars.push(currentReg);
    for (const r of semResults) if (r) calendars.push(r);
    return calendars;
  }

  private async fetchElearningInstructors(calendar: SemesterCalendar, studentId: string, password: string): Promise<void> {
    if (!calendar.title || calendar.schedules.length === 0) return;

    // Derive Moodle path from semester title (e.g. "2025/2026 Semester 2" → "25262")
    let semPath = "";
    const slashMatch = calendar.title.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})\s+Semester\s+(\d)/);
    const plainMatch = calendar.title.match(/^20(\d{2})20(\d{2})(\d)$/);
    if (slashMatch) semPath = `${slashMatch[2]}${slashMatch[4]}${slashMatch[5]}`;
    else if (plainMatch) semPath = `${plainMatch[1]}${plainMatch[2]}${plainMatch[3]}`;
    if (!semPath) return;

    try {
      const base = `https://elearning.utm.my/${semPath}`;
      const loginUrl = `${base}/login/index.php`;

      // Login to Moodle
      const initRes = await fetch(loginUrl, { headers: { "User-Agent": UA }, redirect: "manual" });
      let elCookies = parseCookies(initRes.headers.get("set-cookie"), []);
      const loginHtml = await initRes.text();

      const token = loginHtml.match(/name="logintoken"\s+value="([^"]+)"/);
      if (!token) return;

      const body = new URLSearchParams({ username: studentId, password, logintoken: token[1] });
      const loginRes = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Cookie: elCookies.join("; ") },
        body: body.toString(), redirect: "manual",
      });
      elCookies = parseCookies(loginRes.headers.get("set-cookie"), elCookies);

      // Get sesskey from dashboard
      const elHeaders = { "User-Agent": UA, Cookie: elCookies.join("; ") };
      const dashRes = await fetch(`${base}/my/courses.php`, { headers: elHeaders });
      elCookies = parseCookies(dashRes.headers.get("set-cookie"), elCookies);
      const sessMatch = (await dashRes.text()).match(/"sesskey":"([^"]+)"/);
      if (!sessMatch) return;

      // Fetch enrolled courses via Moodle AJAX
      const ajaxUrl = `${base}/lib/ajax/service.php?sesskey=${sessMatch[1]}&info=core_course_get_enrolled_courses_by_timeline_classification`;
      const ajaxRes = await fetch(ajaxUrl, {
        method: "POST",
        headers: { ...elHeaders, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: "core_course_get_enrolled_courses_by_timeline_classification", args: { offset: 0, limit: 0, classification: "all", sort: "fullname" } }]),
      });
      const ajaxData = (await ajaxRes.json()) as any[];
      const courses = ajaxData?.[0]?.data?.courses;
      if (!courses) return;

      // Match elearning courses to schedules and fetch participant pages in parallel
      const matched = courses.flatMap((ec: any) => {
        const code = ec.shortname?.match(/^([A-Z0-9]+)/i)?.[1]?.toUpperCase();
        if (!code) return [];
        const sched = calendar.schedules.find(s => s.code.toUpperCase() === code);
        return sched ? [{ id: ec.id, code, sched }] : [];
      });

      await Promise.all(matched.map(async ({ id, code, sched }: { id: number; code: string; sched: Schedule }) => {
        try {
          const html = await (await fetch(`${base}/user/index.php?id=${id}`, { headers: { ...elHeaders, Cookie: elCookies.join("; ") } })).text();
          const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
          let rm;
          while ((rm = rowRe.exec(html)) !== null) {
            const name = extractTeacherName(rm[1]);
            if (name) { sched.instructor = name; return; }
          }
          // Fallback: scan for teacher name near role text
          const fb = html.match(/<a[^>]*href="[^"]*user\/profile\.php\?id=\d+[^"]*"[^>]*>([^<]+)<\/a>[\s\S]{0,1000}?(?:Teacher|Pengajar|Lecturer)/i);
          if (fb) sched.instructor = fb[1].trim();
        } catch { /* skip */ }
      }));
    } catch { /* skip */ }
  }

  private async fetchCourseRegistration(): Promise<SemesterCalendar | null> {
    const regUrl = "https://studentportal.utm.my/courseRegistration";
    const res = await fetch(regUrl, { headers: this.headers(), redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && !res.headers.get("location")?.includes(regUrl)) return null;

    const html = await res.text();
    const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
    if (!csrfMatch) return null;
    const csrf = csrfMatch[1];

    const sessionMatch = html.match(/Academic Session\s*:\s*(\d+)/i);
    let title = "Current Semester";
    if (sessionMatch) {
      const s = sessionMatch[1];
      title = s.length >= 9 ? `${s.substring(0, 4)}/${s.substring(4, 8)} Semester ${s.substring(8)}` : s;
    }

    const tbodyMatch = html.match(/<tbody[^>]*id="existingCoursesPmpMpBody"[^>]*>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) return null;

    const schedules: Schedule[] = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let trM;
    while ((trM = trRe.exec(tbodyMatch[1])) !== null) {
      const cells: string[] = [];
      let tdM;
      while ((tdM = tdRe.exec(trM[1])) !== null) cells.push(decodeHtml(stripHtml(tdM[1])));
      if (cells.length >= 5 && cells[1] && cells[4] && cells[1] !== "-") {
        schedules.push({ code: cells[1], title: cells[2], creditHours: parseFloat(cells[3]) || null, section: cells[4], instructor: null, location: null, timeSlots: [] });
      }
    }

    if (schedules.length === 0) return null;

    // Fetch all section details in parallel
    await Promise.all(schedules.map(async (sched) => {
      try {
        const r = await fetch(`https://studentportal.utm.my/courseRegistration/viewSectionDetail?courseCode_token=${encodeURIComponent(sched.code)}`, {
          headers: this.headers({ "X-CSRF-TOKEN": csrf, Accept: "application/json" }),
        });
        const json = (await r.json()) as any;
        const section = String(sched.section).trim();
        for (const sec of json?.getSectionList ?? []) {
          if (sec.jas_seksyem?.toString().trim() !== section) continue;
          if (!sec.day || !sec.masa || sec.day === "-" || sec.masa === "-") continue;
          const parts = sec.masa.split("-").map((t: string) => t.trim());
          if (parts.length === 2) {
            const day = DAYS.indexOf(sec.day.trim().toLowerCase());
            if (day !== -1) sched.timeSlots.push({ day, start: parseTime(parts[0]), end: parseTime(parts[1]) });
          }
        }
      } catch { /* skip */ }
    }));

    return { title, schedules };
  }

  private parseScheduleGrid(html: string): Schedule[] {
    const tableMatch = html.match(/<table[^>]*class="[^"]*table-bordered[^"]*"[^>]*>([\s\S]*?)<\/table>/);
    if (!tableMatch) return [];
    const tableHtml = tableMatch[1];

    const theadMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
    if (!theadMatch) return [];

    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/g;
    const timeSlots: { start: string; end: string }[] = [];
    let thM, isFirst = true;
    while ((thM = thRe.exec(theadMatch[1])) !== null) {
      if (isFirst) { isFirst = false; continue; }
      const parts = decodeHtml(stripHtml(thM[1])).split("-").map(t => t.trim());
      if (parts.length === 2) timeSlots.push({ start: parseTime(parts[0]), end: parseTime(parts[1]) });
    }
    if (timeSlots.length === 0) return [];

    const scheduleMap = new Map<string, Schedule>();
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;

    let rowM;
    while ((rowM = rowRe.exec(tableHtml)) !== null) {
      const rowContent = rowM[1];
      if (rowContent.includes("<th")) continue;

      const cells: string[] = [];
      let tdM;
      while ((tdM = tdRe.exec(rowContent)) !== null) cells.push(tdM[1]);
      if (cells.length === 0) continue;

      const dayIndex = DAYS.indexOf(decodeHtml(stripHtml(cells[0])).toLowerCase());
      if (dayIndex === -1) continue;

      for (let i = 1; i < cells.length; i++) {
        const slotIdx = i - 1;
        if (slotIdx >= timeSlots.length) break;

        const cellText = decodeHtml(
          cells[i]
            .replace(/<div[^>]*class="[^"]*modal[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g, "")
            .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
        );
        if (!cellText || cellText.length < 3) continue;

        const courseMatch = cellText.match(/^([A-Za-z0-9]+)\s*-\s*([A-Za-z0-9]+)\s+(.*)/);
        let code = "", section: string | null = null, location: string | null = null;

        if (courseMatch) {
          code = courseMatch[1].trim();
          section = courseMatch[2].trim();
          location = courseMatch[3].replace(/\s*LOCATION[\s\S]*/i, "").replace(/\s*Close\s*$/i, "").replace(/\s*map-pin\s*/g, "").trim() || null;
        } else {
          const fb = cellText.match(/([A-Za-z]{2,}[0-9]{3,})/);
          if (fb) code = fb[1]; else continue;
        }

        const slot = timeSlots[slotIdx];
        const key = `${code}-${section || ""}`;

        if (!scheduleMap.has(key)) {
          scheduleMap.set(key, { code, title: code, creditHours: null, section, instructor: null, location, timeSlots: [] });
        }
        const sched = scheduleMap.get(key)!;

        // Merge adjacent slots (same day, ≤10min gap)
        const existing = sched.timeSlots.find(t => {
          if (t.day !== dayIndex) return false;
          const gap = toMinutes(slot.start) - toMinutes(t.end);
          return gap >= 0 && gap <= 10;
        });

        if (existing) {
          existing.end = slot.end;
        } else if (!sched.timeSlots.some(t => t.day === dayIndex && t.start === slot.start && t.end === slot.end)) {
          sched.timeSlots.push({ day: dayIndex, start: slot.start, end: slot.end });
        }

        if (location && !sched.location) sched.location = location;
      }
    }

    return Array.from(scheduleMap.values());
  }
}
