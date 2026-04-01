export interface TimeSlot {
  day: number;
  start: string;
  end: string;
}

export interface Schedule {
  code: string;
  title: string;
  creditHours: number | null;
  section: string;
  instructor: string;
  location: string;
  timeSlots: TimeSlot[];
}

export interface SemesterCalendar {
  title: string;
  schedules: Schedule[];
}

export class UniKLScraper {
  private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  private cookies: string[] = [];

  private updateCookies(setCookieHeader: string | null) {
    if (!setCookieHeader) return;
    const newCookies = setCookieHeader.split(/,(?=[^;]+=[^;]+)/).map(c => c.split(';')[0].trim());
    newCookies.forEach(nc => {
      const name = nc.split('=')[0];
      this.cookies = this.cookies.filter(c => !c.startsWith(name + '='));
      this.cookies.push(nc);
    });
  }

  private getCookieHeader() {
    return this.cookies.join('; ');
  }

  // Convert time string "08:30AM" to "08:30" (24-hour mode required by Fyutr)
  private parseTime(timeStr: string): string {
    const cleanTime = timeStr.trim();
    if (!cleanTime) return "00:00";
    
    let hours = parseInt(cleanTime.substring(0, 2), 10);
    const minutes = cleanTime.substring(3, 5);
    const ampm = cleanTime.substring(5, 7).toUpperCase();

    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;

    return `${hours.toString().padStart(2, '0')}:${minutes}`;
  }

  private mapDay(dayStr: string): number {
    const dayMap: Record<string, number> = { "SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6 };
    const cleanDay = dayStr.trim().toUpperCase().substring(0, 3);
    return dayMap[cleanDay] ?? -1;
  }

  async scrape(studentId: string, password: string): Promise<SemesterCalendar[]> {
    const serviceUrl = "https://online1.unikl.edu.my/j_spring_cas_security_check?spring-security-redirect=/home.htm";
    const casUrl = `https://cas.unikl.edu.my/cas-web/login?service=${encodeURIComponent(serviceUrl)}`;

    const initRes = await fetch(casUrl, { headers: { "User-Agent": this.userAgent } });
    this.updateCookies(initRes.headers.get("set-cookie"));
    
    const initHtml = await initRes.text();
    const ltMatch = initHtml.match(/name="lt"\s+value="([^"]+)"/);
    if (!ltMatch) throw new Error("Failed to get login ticket (lt)");

    const actionMatch = initHtml.match(/action="([^"]+)"/);
    const postUrl = actionMatch ? `https://cas.unikl.edu.my${actionMatch[1].replace(/&amp;/g, '&')}` : casUrl;

    const loginBody = new URLSearchParams();
    loginBody.set("username", studentId);
    loginBody.set("password", password);
    loginBody.set("lt", ltMatch[1]);
    loginBody.set("_eventId", "submit");
    loginBody.set("submit2", "Login");

    const loginRes = await fetch(postUrl, {
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
      throw new Error("Login failed (Invalid UniKL credentials)");
    }

    const sessionRes = await fetch(ticketUrl, {
      headers: { "User-Agent": this.userAgent, Cookie: this.getCookieHeader() },
      redirect: "manual",
    });
    this.updateCookies(sessionRes.headers.get("set-cookie"));

    // Base timetable request 
    const timetableUrl = "https://online1.unikl.edu.my/timetable.htm";
    const scheduleRes = await fetch(timetableUrl, {
      headers: { "User-Agent": this.userAgent, Cookie: this.getCookieHeader() }
    });
    const scheduleHtml = await scheduleRes.text();

    // Parse available semesters from dropdown
    const semesterRegex = /<option\s+value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g;
    const semesters: { id: string, title: string }[] = [];
    let match;
    while ((match = semesterRegex.exec(scheduleHtml)) !== null) {
      if (match[1] && match[1].trim() !== "") {
        semesters.push({
          id: match[1].trim(),
          title: match[2].trim().replace(/\s+/g, ' ')
        });
      }
    }

    const calendars: SemesterCalendar[] = [];

    // Concurrent fetch for all semesters (Promise.all style)
    const scrapePromises = semesters.map(async (sem) => {
      const formBody = new URLSearchParams();
      formBody.set("selSemester", sem.id);
      formBody.set("actionform", "search");

      const semRes = await fetch(timetableUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.userAgent,
          Cookie: this.getCookieHeader(),
        },
        body: formBody.toString()
      });
      
      const semHtml = await semRes.text();
      const schedules = this.parseScheduleHTML(semHtml);

      // Only push calendar if there is actual schedule data
      if (schedules.length > 0) {
        return { title: sem.title, schedules };
      }
      return null;
    });

    const results = await Promise.all(scrapePromises);
    results.forEach(res => { if (res) calendars.push(res); });

    return calendars;
  }

  // Jargon's Elite Regex Extract Logic
  private parseScheduleHTML(html: string): Schedule[] {
    const tableMatch = html.match(/<table id="timetable"[^>]*>([\s\S]*?)<\/table>/);
    if (!tableMatch) return [];
    
    const tableHtml = tableMatch[1];
    
    // 1. Extract Time Headers from <thead>
    const theadMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
    if (!theadMatch) return [];
    
    const headersRegex = /<th[^>]*>([\s\S]*?)<\/th>/g;
    const timeSlots: { start: string, end: string }[] = [];
    let hMatch;
    
    while ((hMatch = headersRegex.exec(theadMatch[1])) !== null) {
      const cellContent = hMatch[1].replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' ');
      if (cellContent.includes("-")) {
        const parts = cellContent.split("-").map(p => p.trim());
        timeSlots.push({ start: this.parseTime(parts[0]), end: this.parseTime(parts[1]) });
      }
    }

    // 2. Extract Data from <tbody>
    const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) return [];
    
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    
    // We will aggregate schedules here (using course code as key)
    const scheduleMap = new Map<string, Schedule>();

    let rowMatch;
    while ((rowMatch = rowRegex.exec(tbodyMatch[1])) !== null) {
      const rowContent = rowMatch[1];
      const cells: string[] = [];
      let cellMatch;
      
      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        cells.push(cellMatch[1]);
      }

      if (cells.length === 0) continue;
      
      // First cell is the Day (Mon, Tue, etc)
      const dayRaw = cells[0].replace(/<[^>]*>/g, '').trim();
      const dayIndex = this.mapDay(dayRaw);
      
      if (dayIndex === -1) continue;

      // The rest of the cells correspond to the 'timeSlots' array
      for (let i = 1; i < cells.length; i++) {
        if (i - 1 >= timeSlots.length) break; 
        
        const cellData = cells[i];
        
        // Match subject data using non-greedy operators
        // Code (Type)
        // Room: R
        // Group: G
        // Instructor
        const subjectRegex = /([A-Za-z0-9]+(?:\s*[A-Za-z0-9]+)*)\s*\(<font[^>]*>(?:.*?)<\/font>\)\s*<br>\s*Room\s*:\s*(.*?)\s*<br>\s*Group\s*:\s*(.*?)\s*<br>\s*(.*?)\s*<br>/i;
        const subMatch = cellData.match(subjectRegex);

        if (subMatch) {
          const code = subMatch[1].trim();
          const location = subMatch[2].trim();
          const section = subMatch[3].trim();
          const instructor = subMatch[4].trim();
          
          const slot = timeSlots[i - 1]; // Current column time block
          
          if (!scheduleMap.has(code)) {
            scheduleMap.set(code, {
              code: code,
              title: code, // UniKL HTML doesn't include Subject Title, so we fallback to code
              creditHours: null,
              section: section,
              instructor: instructor,
              location: location,
              timeSlots: []
            });
          }
          
          const sched = scheduleMap.get(code)!;
          
          // Basic logic to merge consecutive time slots gracefully
          const existingSlot = sched.timeSlots.find(t => t.day === dayIndex && t.end === slot.start && sched.location === location);
          
          if (existingSlot) {
            existingSlot.end = slot.end; // Extend the class duration
          } else {
            sched.timeSlots.push({
              day: dayIndex,
              start: slot.start,
              end: slot.end
            });
          }
        }
      }
    }
    
    return Array.from(scheduleMap.values());
  }
}
