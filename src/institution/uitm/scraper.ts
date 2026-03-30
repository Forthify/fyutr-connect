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

export class UiTMScraper {
  private mapDay(dayStr: string): number {
    const dayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    return dayMap[dayStr.toLowerCase()] ?? 0;
  }

  private parseTime(timeStr: string): string {
    const match = timeStr.match(/\d{2}:\d{2}/);
    return match ? match[0] : "00:00";
  }

  async scrape(
    studentId: string,
    password: string,
  ): Promise<SemesterCalendar[]> {
    // Normalize studentId to just the UID part if an email was provided
    if (studentId.includes("@")) {
      studentId = studentId.split("@")[0];
    }

    // 1. Authenticate to ensure valid credentials using ECR portal fallback
    // The user provided a specific encrypted URL for authentication.
    // Valid credentials return a 302 Redirect to 'main.cfm?status=1'.
    const authUrl = "https://ecr.uitm.edu.my/estudent/ecr/index.cfm?id=1&idEncrypted=18DBBE5DBCBD0A03B6FBD5B1CF0DC38AA5E826F2DF010D2950FD54D6284C891FFD56D4DB5585E4C448F9F7E8A79A15AE7C0D3399B3A284DD1A56E7E35E86CBFF0BFCE6CF89CFFADCA70BCADE97039E240786BD8BBC50B60A01CCD7E8EE58FD17";
    
    const formData = new URLSearchParams();
    formData.append("txtUser", studentId);
    formData.append("txtPass", password);
    formData.append("btnLogin", ""); // Submit button name

    const authRes = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: formData.toString(),
      redirect: "manual",
    });

    const location = authRes.headers.get("location");
    const isSuccess = authRes.status === 302 && location?.includes("main.cfm?status=1");

    if (!isSuccess) {
      throw new Error(
        "Login failed: Invalid credentials. Please check your Student ID and Password.",
      );
    }

    // 2. Fetch the CDN JSON payload containing the schedule
    const scheduleUrl = `https://cdn.uitm.link/jadual/baru/${studentId}.json`;
    const scheduleRes = await fetch(scheduleUrl);

    if (!scheduleRes.ok) {
      if (scheduleRes.status === 404 || scheduleRes.status === 403) {
        // Return empty schedule for the current semester if not found on CDN
        return [
          {
            title: "20262",
            schedules: [],
          },
        ];
      }
      throw new Error(
        `Failed to fetch timetable data: ${scheduleRes.statusText}`,
      );
    }

    let rawData: any;
    try {
      rawData = await scheduleRes.json();
    } catch (err: any) {
      throw new Error("Failed to parse timetable data.");
    }

    // 3. Process the nested JSON structures
    // The structure groups classes by distinct dates. We only care about the unique classes and the days they occur.
    const schedulesMap = new Map<string, Schedule>();

    for (const dateKey of Object.keys(rawData)) {
      const dayData = rawData[dateKey];
      if (!dayData || !dayData.jadual || dayData.jadual.length === 0) {
        continue;
      }

      const dayIndex = this.mapDay(dayData.hari);

      for (const item of dayData.jadual) {
        // Build a unique key for the section/course to aggregate timeslots
        // Using courseid + groups to prevent collisions
        const uniqueKey = `${item.courseid}-${item.groups}`;

        let startStr = "00:00";
        let endStr = "00:00";
        if (item.masa && item.masa.includes("-")) {
          const parts = item.masa.split("-").map((t: string) => t.trim());
          if (parts.length === 2) {
            startStr = this.parseTime(parts[0]);
            endStr = this.parseTime(parts[1]);
          }
        }

        const newTimeSlot: TimeSlot = {
          day: dayIndex,
          start: startStr,
          end: endStr,
        };

        if (schedulesMap.has(uniqueKey)) {
          // If we already added this course+section, just push the new timeslot (check for dupes if needed)
          const existing = schedulesMap.get(uniqueKey)!;
          // Verify we aren't adding the exact same day/time (since they can duplicate across weeks in the JSON)
          const isDuplicate = existing.timeSlots.some(
            (t) =>
              t.day === newTimeSlot.day &&
              t.start === newTimeSlot.start &&
              t.end === newTimeSlot.end,
          );
          if (!isDuplicate) {
            existing.timeSlots.push(newTimeSlot);
          }
        } else {
          // Add brand new schedule
          schedulesMap.set(uniqueKey, {
            code: item.courseid || "",
            title: item.course_desc || "",
            creditHours: null,
            section: item.groups || null,
            instructor: item.lecturer || null,
            location: item.bilik || null,
            timeSlots: [newTimeSlot],
          });
        }
      }
    }

    const schedules = Array.from(schedulesMap.values());

    return [
      {
        title: "20262",
        schedules,
      },
    ];
  }
}
