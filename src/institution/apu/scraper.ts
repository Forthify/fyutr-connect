interface TimeSlot {
  day: number;
  start: string;
  end: string;
  instructor: string | null;
  location: string | null;
}

interface Schedule {
  code: string;
  title: string;
  creditHours: number | null;
  section: string | number | null;
  timeSlots: TimeSlot[];
}

interface SemesterCalendar {
  title: string | null;
  schedules: Schedule[];
}

// Maps APU's day strings to 0–6 (Sun=0)
const DAY_MAP: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

function parseTime(timeStr: string): string {
  // Convert "08:30 AM" / "01:30 PM" → "08:30" / "13:30"
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return "00:00";
  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const period = match[3].toUpperCase();
  if (period === "AM" && hours === 12) hours = 0;
  if (period === "PM" && hours !== 12) hours += 12;
  return `${String(hours).padStart(2, "0")}:${minutes}`;
}

export class ApuScraper {
  async scrape(
    studentId: string,
    _password: string,
  ): Promise<SemesterCalendar[]> {
    const res = await fetch(
      "https://s3-ap-southeast-1.amazonaws.com/open-ws/weektimetable",
    );

    if (!res.ok) {
      throw new Error(`Failed to fetch APU timetable: ${res.status}`);
    }

    const raw: any[] = await res.json();

    // Filter entries belonging to this student's intake group
    // The SAMACCOUNTNAME or INTAKE won't directly match studentId,
    // so we match by SAMACCOUNTNAME (student's APU username)
    const entries = raw.filter(
      (entry) =>
        entry.INTAKE?.trim().toLowerCase() === studentId.trim().toLowerCase(),
    );

    if (entries.length === 0) {
      throw new Error(
        "Login failed: No timetable found for intake code: " + studentId,
      );
    }

    // Group by module code to merge time slots
    const moduleMap = new Map<string, Schedule>();

    for (const entry of entries) {
      const code: string = entry.MODID ?? "UNKNOWN";
      const dayNum = DAY_MAP[entry.DAY?.toUpperCase()] ?? -1;
      if (dayNum === -1) continue;

      const slot: TimeSlot = {
        day: dayNum,
        start: parseTime(entry.TIME_FROM),
        end: parseTime(entry.TIME_TO),
        instructor: entry.NAME ?? null,
        location: entry.ROOM
          ? `${entry.LOCATION ?? ""}, ${entry.ROOM}`.replace(/^,\s*/, "")
          : (entry.LOCATION ?? null),
      };

      if (moduleMap.has(code)) {
        const existing = moduleMap.get(code)!;
        // Avoid duplicate slots
        const isDuplicate = existing.timeSlots.some(
          (s) =>
            s.day === slot.day && s.start === slot.start && s.end === slot.end,
        );
        if (!isDuplicate) {
          existing.timeSlots.push(slot);
        }
      } else {
        moduleMap.set(code, {
          code,
          title: entry.MODULE_NAME ?? "Unknown Module",
          creditHours: null,
          section: entry.GROUPING ?? null,
          timeSlots: [slot],
        });
      }
    }

    const schedules = Array.from(moduleMap.values());

    return [
      {
        title: new Date().toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        }), // APU feed doesn't expose semester name
        schedules,
      },
    ];
  }
}
