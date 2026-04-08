export interface TimeSlot {
  day: number;
  start: string;
  end: string;
  instructor?: string | null;
  location?: string | null;
}

export interface Schedule {
  code: string;
  title: string;
  creditHours: number | null;
  section: string | number | null;
  timeSlots: TimeSlot[];
}

export interface SemesterCalendar {
  title: string | null;
  schedules: Schedule[];
}

type CurriculumCourse = { code: string; name: string };
type SemesterInfo = { id: string; title: string; isLatest: boolean };
type CourseRegistration = SemesterCalendar & { sesisem: string };
type ElearningCourse = {
  id: number;
  shortname?: string;
  fullname?: string;
  contacts?: Array<{ fullname?: string }>;
};
type SectionDetail = {
  day?: string;
  masa?: string;
  jas_seksyem?: string | number;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const STUDENT_PORTAL = "https://studentportal.utm.my";
const DEFAULT_SESISEM = "202420251";
const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const LOGIN_ERRORS = {
  missingToken:
    "Login failed: Could not extract CSRF token from UTM login page.",
  invalidCredentials:
    "Login failed: Invalid credentials. Please check your UTM ID and Password.",
  session: "Login failed: Session not established on student portal.",
};
const TEACHER_MARKERS = [
  "Teacher",
  "Pengajar",
  "Lecturer",
  "Non-editing teacher",
];
const TEACHER_NAME_PATTERNS = [
  /class="userlink"[^>]*>([^<]+)<\/a>/i,
  /<th[^>]*class="(?:[^"]*\s)?c1(?:\s[^"]*)?"[^>]*>.*?<a[^>]*>([^<]+)<\/a>/is,
  /<th[^>]*>.*?<a[^>]*course=\d+[^>]*>([^<]+)<\/a>/is,
  /<a[^>]*href="[^"]*user\/profile\.php\?id=\d+[^"]*"[^>]*>([^<]+)<\/a>/i,
];
const MODAL_RE =
  /<div[^>]*class="[^"]*modal[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g;

const isRedirect = (status: number) => status >= 300 && status < 400;
const toAbsoluteUrl = (baseUrl: string, url: string) =>
  url.startsWith("http") ? url : `${baseUrl}${url}`;
const formatSemesterTitle = (id: string, fallback = id) =>
  id.length >= 9
    ? `${id.slice(0, 4)}/${id.slice(4, 8)} Semester ${id.slice(8)}`
    : fallback;
const normalizeName = (name: string) => name.replace(/\s+\d{3,8}$/, "").trim();
const dayIndex = (day: string) => DAYS.indexOf(day.trim().toLowerCase());
const findCourseCode = (text: string) =>
  text.match(/([A-Z]{2,4}\d{4})/i)?.[1]?.toUpperCase() ?? null;
const moodlePathForSemester = (id: string) =>
  id.match(/^20(\d{2})20(\d{2})(\d)$/)?.slice(1).join("") ?? null;

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function cleanText(html: string): string {
  return decodeHtml(stripHtml(html));
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function parseCookies(header: string | null, existing: string[]): string[] {
  if (!header) return existing;
  const result = [...existing];
  header
    .split(/,(?=[^;]+=[^;]+)/)
    .map((cookie) => cookie.split(";")[0].trim())
    .forEach((cookie) => {
      const name = cookie.split("=")[0];
      const index = result.findIndex((value) => value.startsWith(name + "="));
      if (index >= 0) result[index] = cookie;
      else result.push(cookie);
    });
  return result;
}

function decodeHtml(html: string): string {
  if (!html.includes("&")) return html;
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    "#039": "'",
    nbsp: " ",
  };
  return html.replace(
    /&(amp|lt|gt|quot|#0?39|nbsp|copy|middot);/g,
    (match, entity) => entities[entity] ?? match,
  );
}

function parseTime(timeStr: string): string {
  const match = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return "00:00";
  let hour = parseInt(match[1], 10);
  if (match[3].toUpperCase() === "PM" && hour < 12) hour += 12;
  if (match[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  return `${hour.toString().padStart(2, "0")}:${match[2]}`;
}

function rows(html: string): string[] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(
    ([, row]) => row,
  );
}

function cells(html: string, tag: "td" | "th" = "td"): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...html.matchAll(re)].map(([, cell]) => cell);
}

function extractTeacherName(rowText: string): string | null {
  if (!TEACHER_MARKERS.some((marker) => rowText.includes(marker))) return null;
  for (const pattern of TEACHER_NAME_PATTERNS) {
    const match = rowText.match(pattern);
    if (match && match[1]) {
      return normalizeName(decodeHtml(stripHtml(match[1])));
    }
  }
  return null;
}

function mergeTimeSlot(
  schedule: Schedule,
  day: number,
  slot: { start: string; end: string; instructor?: string | null; location?: string | null },
) {
  const existing = schedule.timeSlots.find((timeSlot) => {
    if (timeSlot.day !== day || timeSlot.location !== slot.location) return false;
    const gap = toMinutes(slot.start) - toMinutes(timeSlot.end);
    return gap >= 0 && gap <= 10;
  });

  if (existing) {
    existing.end = slot.end;
    return;
  }

  if (
    !schedule.timeSlots.some(
      (timeSlot) =>
        timeSlot.day === day &&
        timeSlot.start === slot.start &&
        timeSlot.end === slot.end,
    )
  ) {
    schedule.timeSlots.push({
      day,
      start: slot.start,
      end: slot.end,
      instructor: slot.instructor ?? null,
      location: slot.location ?? null,
    });
  }
}

export class UTMScraper {
  private cookies: string[] = [];

  private updateCookies(header: string | null) {
    this.cookies = parseCookies(header, this.cookies);
  }
  private get cookieHeader() {
    return this.cookies.join("; ");
  }

  private async request(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": UA,
        Cookie: this.cookieHeader,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    this.updateCookies(response.headers.get("set-cookie"));
    return response;
  }

  private async followRedirects(baseUrl: string, nextUrl: string | null) {
    for (let i = 0; nextUrl && i < 10; i++) {
      const response = await this.request(toAbsoluteUrl(baseUrl, nextUrl), {
        redirect: "manual",
      });
      await response.text();
      nextUrl = isRedirect(response.status)
        ? response.headers.get("location")
        : null;
    }
  }

  private async loginToPortal(
    baseUrl: string,
    studentId: string,
    password: string,
  ): Promise<void> {
    const loginUrl = `${baseUrl}/login`;
    const loginPage = await this.request(loginUrl, { redirect: "manual" });
    const loginHtml =
      isRedirect(loginPage.status) && loginPage.headers.get("location")
        ? await (
            await this.request(
              toAbsoluteUrl(baseUrl, loginPage.headers.get("location")!),
            )
          ).text()
        : await loginPage.text();

    const token = [
      /name="_token"\s+(?:type="hidden"\s+)?value="([^"]+)"/,
      /value="([^"]+)"\s*(?:type="hidden"\s*)?name="_token"/,
      /<meta\s+name="csrf-token"\s+content="([^"]+)"/,
    ]
      .map((re) => loginHtml.match(re)?.[1])
      .find((value): value is string => Boolean(value));

    if (!token) throw new Error(LOGIN_ERRORS.missingToken);

    const response = await this.request(loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: loginUrl,
        Origin: baseUrl,
      },
      body: new URLSearchParams({
        _token: token,
        [loginHtml.includes('name="email"') ? "email" : "username"]: studentId,
        password,
      }).toString(),
      redirect: "manual",
    });

    const nextUrl = response.headers.get("location");
    if (!nextUrl || nextUrl.includes("/login") || response.status === 422) {
      throw new Error(LOGIN_ERRORS.invalidCredentials);
    }

    await this.followRedirects(baseUrl, nextUrl);
  }

  private async fetchTimetableLanding(): Promise<string> {
    const response = await this.request(`${STUDENT_PORTAL}/timetablePersonalize`, {
      redirect: "manual",
    });
    const html = await response.text();
    if (
      isRedirect(response.status) ||
      html.includes("STUDENTLogin") ||
      html.includes('name="username"')
    ) {
      throw new Error(LOGIN_ERRORS.session);
    }
    return html;
  }

  private listSemesters(
    timetableHtml: string,
    curriculumMap: Map<string, CurriculumCourse[]>,
    latestSesisem: string,
    hasRegistration: boolean,
  ): SemesterInfo[] {
    const ids = new Set(curriculumMap.keys());
    for (const [, value] of timetableHtml.matchAll(
      /<option\s+value="([^"]+)"[^>]*>[^<]*<\/option>/g,
    )) {
      const id = value.trim();
      if (/^\d+$/.test(id)) ids.add(id);
    }
    if (!ids.size && hasRegistration) ids.add(latestSesisem);
    return [...ids].map((id) => ({
      id,
      title: formatSemesterTitle(id),
      isLatest: id === latestSesisem,
    }));
  }

  private async fetchSemesterGrid(id: string): Promise<Schedule[]> {
    try {
      const html = await (
        await this.request(
          `${STUDENT_PORTAL}/timetablePersonalizeSearch?semester=${id}`,
        )
      ).text();
      return this.parseScheduleGrid(html);
    } catch {
      return [];
    }
  }

  private async fetchSemesterTimetables(
    semesters: SemesterInfo[],
    registration: CourseRegistration | null,
  ) {
    return new Map(
      await Promise.all(
        semesters.map(async (semester) => {
          const schedules =
            semester.isLatest && registration
              ? registration.schedules
              : await this.fetchSemesterGrid(semester.id);
          return [
            semester.id,
            new Map(
              schedules.map(
                (schedule) => [schedule.code.toUpperCase(), schedule] as const,
              ),
            ),
          ] as const;
        }),
      ),
    );
  }

  private mergeSchedules(
    curriculumCourses: CurriculumCourse[],
    timetable: Map<string, Schedule>,
  ): Schedule[] {
    const added = new Set<string>();
    const schedules = curriculumCourses.map((course) => {
      const code = course.code.toUpperCase();
      const timetableMatch = timetable.get(code);
      added.add(code);
      return {
        code: course.code,
        title: course.name || timetableMatch?.title || course.code,
        creditHours: timetableMatch?.creditHours ?? null,
        section: timetableMatch?.section ?? null,
        timeSlots: timetableMatch?.timeSlots ?? [],
      };
    });

    for (const [code, schedule] of timetable) {
      if (!added.has(code)) schedules.push(schedule);
    }
    return schedules;
  }

  private buildCalendars(
    semesters: SemesterInfo[],
    curriculumMap: Map<string, CurriculumCourse[]>,
    timetableBySemester: Map<string, Map<string, Schedule>>,
  ): SemesterCalendar[] {
    return semesters
      .map((semester) => ({
        title: semester.title,
        schedules: this.mergeSchedules(
          curriculumMap.get(semester.id) ?? [],
          timetableBySemester.get(semester.id) ?? new Map<string, Schedule>(),
        ),
      }))
      .filter((calendar) => calendar.schedules.length > 0);
  }

  private async fillSectionDetails(schedule: Schedule, csrf: string) {
    try {
      const response = await this.request(
        `${STUDENT_PORTAL}/courseRegistration/viewSectionDetail?courseCode_token=${encodeURIComponent(schedule.code)}`,
        {
          headers: {
            "X-CSRF-TOKEN": csrf,
            Accept: "application/json",
          },
        },
      );

      const sections = (
        ((await response.json()) as { getSectionList?: SectionDetail[] })
          .getSectionList ?? []
      ).filter(({ day, masa }) => day && masa && day !== "-" && masa !== "-");
      const matches = sections.filter(
        (section) =>
          String(section.jas_seksyem ?? "").trim() ===
          String(schedule.section ?? "").trim(),
      );

      for (const section of matches.length ? matches : sections.slice(0, 1)) {
        const [start, end] =
          section.masa?.split("-").map((time) => time.trim()) ?? [];
        const day = section.day ? dayIndex(section.day) : -1;
        if (!start || !end || day < 0) continue;
        mergeTimeSlot(schedule, day, {
          start: parseTime(start),
          end: parseTime(end),
        });
      }
    } catch {
      /* skip */
    }
  }

  async scrape(
    studentId: string,
    password: string,
  ): Promise<SemesterCalendar[]> {
    await this.loginToPortal(STUDENT_PORTAL, studentId, password);

    const timetableHtml = await this.fetchTimetableLanding();
    const [curriculumMap, registration] = await Promise.all([
      this.fetchCurriculumCourses(),
      this.fetchCourseRegistration(),
    ]);

    const latestSesisem = registration?.sesisem ?? DEFAULT_SESISEM;
    const semesters = this.listSemesters(
      timetableHtml,
      curriculumMap,
      latestSesisem,
      Boolean(registration),
    );
    const calendars = this.buildCalendars(
      semesters,
      curriculumMap,
      await this.fetchSemesterTimetables(semesters, registration),
    );
    const moodlePaths = [
      ...new Set(
        semesters
          .map(({ id }) => moodlePathForSemester(id))
          .filter((path): path is string => Boolean(path)),
      ),
    ];

    if (calendars.length && moodlePaths.length) {
      await this.fetchElearningInstructors(
        calendars.flatMap((calendar) => calendar.schedules),
        moodlePaths,
        studentId,
        password,
      );
    }

    return calendars;
  }

  private async fetchCurriculumCourses(): Promise<
    Map<string, CurriculumCourse[]>
  > {
    const result = new Map<string, CurriculumCourse[]>();
    try {
      const response = await this.request(`${STUDENT_PORTAL}/curriculumStructure`);
      if (response.status !== 200) return result;

      let currentSesisem = "";
      for (const row of rows(await response.text())) {
        if (
          row.includes("color:gray") ||
          row.includes("colspan") ||
          !row.includes("font-weight:bold")
        ) {
          continue;
        }

        const [sesisemCell, nameCell, codeCell] = cells(row);
        const code = codeCell?.match(/>([A-Z]{2,4}\d{4})</)?.[1];
        const name = nameCell ? stripHtml(nameCell) : "";
        currentSesisem =
          sesisemCell?.match(/(\d{9})/)?.[1] ?? currentSesisem;
        if (!currentSesisem || !code || !name) continue;

        const courses = result.get(currentSesisem) ?? [];
        if (!result.has(currentSesisem)) result.set(currentSesisem, courses);
        if (!courses.some((course) => course.code === code)) {
          courses.push({ code, name });
        }
      }
    } catch {
      /* fall back to timetable-only */
    }
    return result;
  }

  private async fetchElearningInstructors(
    schedules: Schedule[],
    moodlePaths: string[],
    studentId: string,
    password: string,
  ): Promise<void> {
    const scheduleByCode = new Map(
      schedules.map((schedule) => [schedule.code.toUpperCase(), schedule]),
    );

    for (const path of moodlePaths) {
      try {
        const base = `https://elearning.utm.my/${path}`;
        const loginUrl = `${base}/login/index.php`;
        let cookies: string[] = [];
        const request = async (url: string, init: RequestInit = {}) => {
          const response = await fetch(url, {
            ...init,
            headers: {
              "User-Agent": UA,
              Cookie: cookies.join("; "),
              ...(init.headers as Record<string, string> | undefined),
            },
          });
          cookies = parseCookies(response.headers.get("set-cookie"), cookies);
          return response;
        };

        const loginHtml = await (
          await request(loginUrl, { redirect: "manual" })
        ).text();
        const token = loginHtml.match(/name="logintoken"\s+value="([^"]+)"/)?.[1];
        if (!token) continue;

        const login = await request(loginUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            username: studentId,
            password,
            logintoken: token,
          }).toString(),
          redirect: "manual",
        });
        const nextUrl = login.headers.get("location");
        if (nextUrl) await (await request(nextUrl, { redirect: "manual" })).text();

        const sesskey = (await (
          await request(`${base}/my/courses.php`)
        ).text()).match(/"sesskey":"([^"]+)"/)?.[1];
        if (!sesskey) continue;

        const courses = (
          (await (
            await request(
              `${base}/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                body: JSON.stringify([
                  {
                    index: 0,
                    methodname:
                      "core_course_get_enrolled_courses_by_timeline_classification",
                    args: {
                      offset: 0,
                      limit: 0,
                      classification: "all",
                      sort: "fullname",
                    },
                  },
                ]),
              },
            )
          ).json()) as Array<{ data?: { courses?: ElearningCourse[] } }>
        )[0]?.data?.courses;
        if (!courses?.length) continue;

        const fallback = new Map<number, Schedule>();
        for (const course of courses) {
          const code = findCourseCode(
            `${course.shortname ?? ""} ${course.fullname ?? ""}`,
          );
          const schedule = code ? scheduleByCode.get(code) : null;
          if (!code || !schedule || schedule.timeSlots.some(s => s.instructor)) continue;

          const name = course.contacts?.[0]?.fullname;
          if (name) {
            const normalized = normalizeName(name);
            schedule.timeSlots.forEach((slot) => {
              slot.instructor = normalized;
            });
          } else {
            fallback.set(course.id, schedule);
          }
        }

        await Promise.all(
          [...fallback].map(async ([courseId, schedule]) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            try {
              const html = await (
                await request(`${base}/user/index.php?id=${courseId}`, {
                  signal: controller.signal,
                })
              ).text();
              const name = rows(html)
                .find((value): value is string => Boolean(value));
              if (name) {
                schedule.timeSlots.forEach((slot) => {
                  slot.instructor = name;
                });
              }
            } catch {
              /* skip */
            } finally {
              clearTimeout(timer);
            }
          }),
        );
      } catch {
        /* skip */
      }
    }
  }

  private async fetchCourseRegistration(): Promise<CourseRegistration | null> {
    const regUrl = `${STUDENT_PORTAL}/courseRegistration`;
    const response = await this.request(regUrl, { redirect: "manual" });
    if (
      isRedirect(response.status) &&
      !response.headers.get("location")?.includes(regUrl)
    ) {
      return null;
    }

    const html = await response.text();
    const csrf = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)?.[1];
    const tbody = html.match(
      /<tbody[^>]*id="existingCoursesPmpMpBody"[^>]*>([\s\S]*?)<\/tbody>/,
    )?.[1];
    if (!csrf || !tbody) return null;

    const sesisem =
      html.match(/id="sesisemId"[^>]*value="([^"]+)"/i)?.[1] ?? DEFAULT_SESISEM;
    const schedules = rows(tbody).flatMap((row) => {
      const [, code, title, creditHours, section] = cells(row).map(cleanText);
      return code && section && code !== "-"
        ? [
            {
              code,
              title,
              creditHours: parseFloat(creditHours) || null,
              section,
              timeSlots: [],
            },
          ]
        : [];
    });
    if (!schedules.length) return null;

    await Promise.all(schedules.map((schedule) => this.fillSectionDetails(schedule, csrf)));

    return {
      title: formatSemesterTitle(sesisem, "Current Semester"),
      schedules,
      sesisem,
    };
  }

  private parseScheduleGrid(html: string): Schedule[] {
    const tableHtml = html.match(
      /<table[^>]*class="[^"]*table-bordered[^"]*"[^>]*>([\s\S]*?)<\/table>/,
    )?.[1];
    const thead = tableHtml?.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1];
    if (!tableHtml || !thead) return [];

    const timeSlots = cells(thead, "th").slice(1).flatMap((cell) => {
      const [start, end] = cleanText(cell).split("-").map((part) => part.trim());
      return start && end
        ? [{ start: parseTime(start), end: parseTime(end) }]
        : [];
    });
    if (!timeSlots.length) return [];

    const schedules = new Map<string, Schedule>();
    for (const row of rows(tableHtml)) {
      if (row.includes("<th")) continue;

      const [dayCell, ...slotCells] = cells(row);
      const day = dayCell ? dayIndex(cleanText(dayCell)) : -1;
      if (day < 0) continue;

      slotCells.forEach((cell, index) => {
        const slot = timeSlots[index];
        if (!slot) return;

        const cellText = decodeHtml(
          cell
            .replace(MODAL_RE, "")
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        );
        if (cellText.length < 3) return;

        const match = cellText.match(
          /^([A-Za-z0-9]+)\s*-\s*([A-Za-z0-9]+)\s+(.*)/,
        );
        const code = match?.[1]?.trim() ?? findCourseCode(cellText);
        if (!code) return;

        const section = match?.[2]?.trim() ?? null;
        const location =
          match?.[3]
            ?.replace(/\s*LOCATION[\s\S]*/i, "")
            .replace(/\s*Close\s*$/i, "")
            .replace(/\s*map-pin\s*/g, "")
            .trim() || null;
        const key = `${code}-${section ?? ""}`;
        const schedule =
          schedules.get(key) ??
          {
            code,
            title: code,
            creditHours: null,
            section,
            timeSlots: [],
          };

        if (!schedules.has(key)) schedules.set(key, schedule);
        mergeTimeSlot(schedule, day, { ...slot, location });
      });
    }

    return [...schedules.values()];
  }
}
