interface TimeSlot {
  day: number;
  start: string;
  end: string;
}

interface Schedule {
  code: string;
  title: string;
  creditHours: number | null;
  section: string | number | null;
  instructor: string | null;
  location: string | null;
  timeSlots: TimeSlot[];
}

interface SemesterCalendar {
  title: string | null;
  schedules: Schedule[];
}

const DAY_MAP: Record<string, number> = {
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
  SUN: 0,
};

function formatTime(time: string): string {
  return `${time.slice(0, 2)}:${time.slice(2)}`;
}

export class UpsiScraper {
  private cookie = "";

  private updateCookie(setCookie: string | null) {
    if (!setCookie) return;

    const newCookies = setCookie
      .split(/,(?=[^;]+=[^;]+)/)
      .map((c) => c.split(";")[0]);

    const cookieMap = new Map<string, string>();

    this.cookie.split("; ").forEach((c) => {
      const [k, v] = c.split("=");
      if (k && v) cookieMap.set(k, v);
    });

    newCookies.forEach((c) => {
      const [k, v] = c.split("=");
      if (k && v) cookieMap.set(k, v);
    });

    this.cookie = Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  async scrape(studentId: string, password: string): Promise<SemesterCalendar[]> {

    const loginRes = await fetch(
      "https://unistudent.upsi.edu.my/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          username: studentId,
          password: password,
        }),
        redirect: "manual",
      }
    );

    this.updateCookie(loginRes.headers.get("set-cookie"));

    if (!this.cookie.includes("ci_session")) {
      throw new Error("Login failed: Invalid credentials");
    }
  );

    const viewRes = await fetch(
      "https://unistudent.upsi.edu.my/timetable/timetable/view",
      {
        method: "GET",
        headers: {
          Cookie: this.cookie,
        },
      }
    );
    this.updateCookie(viewRes.headers.get("set-cookie"));

    const regRes = await fetch(
      "https://unistudent.upsi.edu.my/timetable/timetable/getRegisteredCourse",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: this.cookie,
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://unistudent.upsi.edu.my/timetable/timetable/view",
        },
        body: "",
      }
    );
    this.updateCookie(regRes.headers.get("set-cookie"));

    const res = await fetch(
      "https://unistudent.upsi.edu.my/timetable/timetable/getMyTimetableQuery",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: this.cookie,
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://unistudent.upsi.edu.my/timetable/timetable/view",
        },
        body: "type=LECT", 
      }
    );

    this.updateCookie(res.headers.get("set-cookie"));

    if (!res.ok) {
      throw new Error("Failed to fetch timetable");
    }

    const data = await res.json();

    if (!data.timetable || data.timetable.length === 0) {
      throw new Error("Login failed: No timetable found");
    }

    
    const slotMap = new Map<string, { start: string; end: string }>();

    for (const s of data.slot) {
      slotMap.set(s.TS_SLOT, {
        start: formatTime(s.TIMESTART),
        end: formatTime(s.TIMEEND),
      });
    }

    const moduleMap = new Map<string, Schedule>();

    for (const item of data.timetable) {
      const code = item.SUBJECT ?? "UNKNOWN";

      const startSlot = slotMap.get(item.SLOT_FROM);
      const endSlot = slotMap.get(item.SLOT_TO);

      if (!startSlot || !endSlot) continue;

      const timeSlot: TimeSlot = {
        day: DAY_MAP[item.DAY],
        start: startSlot.start,
        end: endSlot.end,
      };

      if (moduleMap.has(code)) {
        const existing = moduleMap.get(code)!;

        const duplicate = existing.timeSlots.some(
          (s) =>
            s.day === timeSlot.day &&
            s.start === timeSlot.start &&
            s.end === timeSlot.end
        );

        if (!duplicate) {
          existing.timeSlots.push(timeSlot);
        }
      } else {
        moduleMap.set(code, {
          code,
          title: item.SUBJECT_NAME ?? "Unknown",
          creditHours: null,
          section: item.GROUP ?? null,
          instructor: item.LECTURER ?? null,
          location: item.ROOM ?? null,
          timeSlots: [timeSlot],
        });
      }
    }

    return [
      {
        title: "Current Semester",
        schedules: Array.from(moduleMap.values()),
      },
    ];
  }
}
