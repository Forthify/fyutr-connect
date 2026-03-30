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
    // 1. Authenticate to ensure valid credentials using the Firebase Web API Key for mystudent.uitm
    const apiKey = "AIzaSyCzaZT_qsgrbWBmtFJ0Sg3I-eJbZtntbpM";
    const authUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;

    // Students may use different email domains, or provide their full email
    let emailsToTry: string[] = [];
    
    if (studentId.includes("@")) {
      emailsToTry.push(studentId);
      // Extract just the ID part to use for the CDN fetch later
      studentId = studentId.split("@")[0];
    } else {
      const domains = ["@mystudent.uitm.edu.my", "@siswa.uitm.edu.my", "@student.uitm.edu.my"];
      emailsToTry = domains.map(domain => `${studentId}${domain}`);
    }

    let authRes: Response | null = null;
    
    for (const email of emailsToTry) {
      authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnSecureToken: true,
          email,
          password,
        }),
      });

      if (authRes.ok) {
        break; // Stop trying if we have a successful login
      }
    }

    if (!authRes || !authRes.ok) {
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
