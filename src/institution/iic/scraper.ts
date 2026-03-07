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

export class IICScraper {
  private baseUrl = "https://cms.iic.edu.my/cms";
  private userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

  private mapDay(dayStr: string): number {
    const dayMap: Record<string, number> = {
      SUNDAY: 0,
      MONDAY: 1,
      TUESDAY: 2,
      WEDNESDAY: 3,
      THURSDAY: 4,
      FRIDAY: 5,
      SATURDAY: 6,
    };
    return dayMap[dayStr.trim().toUpperCase()] ?? -1;
  }

  private parseTime(timeStr: string): string {
    // Input format: "0830Hrs" or "1000Hrs" or "0830" or "1600"
    const cleaned = timeStr.replace(/[^0-9]/g, "");
    if (cleaned.length < 3) return "00:00";
    const padded = cleaned.length === 3 ? "0" + cleaned : cleaned;
    return `${padded.substring(0, 2)}:${padded.substring(2, 4)}`;
  }

  /**
   * Extract CDATA or text content from XML elements.
   * This parses the Maestro CMS proprietary XML format.
   */
  private extractCData(xml: string): string {
    const cdataMatch = xml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdataMatch) return cdataMatch[1];
    // Fallback: strip tags
    return xml.replace(/<[^>]*>/g, "").trim();
  }

  /**
   * Extract all string values from MaestroRMI XML response.
   * The format uses <a t="s">value</a> for strings.
   */
  private extractStringValues(xml: string): string[] {
    const values: string[] = [];
    const regex = /<a t="s">([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      values.push(this.extractCData(match[1]));
    }
    return values;
  }

  /**
   * Extract key-value pairs from a DynamicInfo/Map section of the Maestro XML.
   */
  private extractMapEntries(
    xml: string,
  ): Array<{ key: string; value: string | null }> {
    const entries: Array<{ key: string; value: string | null }> = [];
    // Match key-value vector pairs: <a t="V" length="2"><a t="s">KEY</a><a t="s">VALUE</a></a>
    const vectorRegex = /<a t="V" length="2">([\s\S]*?)<\/a>\s*<\/a>/g;
    // Make a more robust pattern - find each V-block
    const vBlockRegex =
      /<a t="V" length="2">\s*<a t="s"><!\[CDATA\[([^\]]*)\]\]><\/a>\s*(?:<a t="s"><!\[CDATA\[([^\]]*)\]\]><\/a>|<a t="null" \/>|<a t="([^"]*)">([\s\S]*?)<\/a>)\s*<\/a>/g;
    let m;
    while ((m = vBlockRegex.exec(xml)) !== null) {
      const key = m[1];
      const value = m[2] !== undefined ? m[2] : m[4] || null;
      entries.push({ key, value });
    }
    return entries;
  }

  async scrape(
    studentId: string,
    password: string,
  ): Promise<SemesterCalendar[]> {
    // 1. Authenticate
    const authBody = new URLSearchParams();
    authBody.set("userPath", "/login");
    authBody.set("userOS", "Mac");
    authBody.set("browserVersion", "145");
    authBody.set("userBrowser", "Chrome 145");
    authBody.set("mobile", "false");
    authBody.set("screenSize", "1920x1080");
    authBody.set("deviceId", `web-chrome-${crypto.randomUUID()}`);
    authBody.set("companyId", "3");
    authBody.set(
      "rmiXML",
      `<maestroRMI><a t="s">${studentId}</a><a t="s">${password}</a></maestroRMI>`,
    );
    authBody.set("className", "com.maestro.common.security.Authenticator");
    authBody.set("methodName", "authenticate");
    authBody.set("injectIpAddress", "true");

    const authRes = await fetch(
      `${this.baseUrl}/servlet/com.maestro.servlet.FrontController`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": this.userAgent,
        },
        body: authBody.toString(),
      },
    );

    const authText = await authRes.text();
    console.log("Auth Response:", authText);

    if (
      authText.includes("status=false") ||
      !authText.includes("status=true")
    ) {
      // Check for specific error messages
      const msgMatch = authText.match(
        /<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/,
      );
      const errorMsg = msgMatch
        ? msgMatch[1]
        : "Login failed: Invalid credentials";
      throw new Error(
        `Login failed: ${errorMsg}. Please check your Student ID and Password.`,
      );
    }

    // Extract userId, sessionId, JWT from auth response
    const entries = this.extractMapEntries(authText);
    const userIdEntry = entries.find((e) => e.key === "userId");
    const userId = userIdEntry?.value;
    if (!userId)
      throw new Error("Failed to extract userId from login response");

    // Extract sessionId - it's a string value after the DI block
    // Format: ...DI block...</a><a t="i">NUMBER</a><a t="s">SESSION_ID</a><a t="s">JWT</a>...
    const sessionIdMatch = authText.match(
      /<\/a><a t="i">\d+<\/a><a t="s">(?:<!\[CDATA\[)?([^\]<]+)(?:\]\]>)?<\/a>/,
    );
    const sessionId = sessionIdMatch?.[1];
    if (!sessionId)
      throw new Error("Failed to extract sessionId from login response");

    // Extract JWT token - right after sessionId
    const jwtMatch = authText.match(
      new RegExp(
        sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          '(?:\\]\\]>)?<\\/a><a t="s">(?:<!\\[CDATA\\[)?([^\\]<]+)(?:\]\\]>)?<\\/a>',
      ),
    );
    const jwt = jwtMatch?.[1];
    if (!jwt) throw new Error("Failed to extract JWT from login response");

    // 2. Discover internal IDs: studentStubId and studentStatusId
    const stubBody = new URLSearchParams();
    stubBody.set("userId", userId);
    stubBody.set("userName", studentId);
    stubBody.set("sessionId", sessionId);
    stubBody.set("className", "SMSStudentStubAdmin");
    stubBody.set("methodName", "getSMSStudentForUser");
    stubBody.set(
      "rmiXML",
      `<maestroRMI><a t="s">${userId}</a><a t="AS"><a t="M" length="5"><a t="V" length="2"><a t="s">smsStudentStubId</a><a t="s">smsStudentStubId</a></a><a t="V" length="2"><a t="s">studentStubId</a><a t="s">studentStubId</a></a><a t="V" length="2"><a t="s">status</a><a t="s">status</a></a><a t="V" length="2"><a t="s">sponsor</a><a t="s">sponsor</a></a><a t="V" length="2"><a t="s">studentStatusId</a><a t="s">studentStatusId</a></a></a><a t="M" length="0"></a></a></maestroRMI>`,
    );

    const stubRes = await fetch(
      `${this.baseUrl}/servlet/com.maestro.servlet.FrontBeanController`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": this.userAgent,
          Authorization: `Bearer ${jwt}`,
        },
        body: stubBody.toString(),
      },
    );

    const stubText = await stubRes.text();
    console.log("Stub Response:", stubText);
    const stubEntries = this.extractMapEntries(stubText);
    const studentStubId = stubEntries.find(
      (e) => e.key === "studentStubId",
    )?.value;
    const studentStatusId = stubEntries.find(
      (e) => e.key === "studentStatusId",
    )?.value;

    if (!studentStubId || !studentStatusId) {
      throw new Error("Failed to retrieve student profile IDs.");
    }

    // 3. Discover academicSemesterId (Current Active Semester)
    const semBody = new URLSearchParams();
    semBody.set("userId", userId);
    semBody.set("userName", studentId);
    semBody.set("sessionId", sessionId);
    semBody.set("className", "SMSAcademicYearAdminBean");
    semBody.set("methodName", "getCurrentActiveSMSAcademicSemester");
    semBody.set("rmiXML", `<maestroRMI></maestroRMI>`);

    const semRes = await fetch(
      `${this.baseUrl}/servlet/com.maestro.servlet.FrontBeanController`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": this.userAgent,
          Authorization: `Bearer ${jwt}`,
        },
        body: semBody.toString(),
      },
    );

    const semText = await semRes.text();
    console.log("Sem Response:", semText);
    let academicSemesterId = this.extractMapEntries(semText).find(
      (e) =>
        e.key === "academicSemesterId" || e.key === "sMSAcademicSemesterId",
    )?.value;

    let semesterTitle = this.extractMapEntries(semText).find(
      (e) => e.key === "semesterName" || e.key === "semesterLongName",
    )?.value;

    // Fallback if it uses ValueObject structure (params/data)
    if (!academicSemesterId) {
      const dataMatch = semText.match(/<data>([\s\S]*?)<\/data>/);
      const paramsMatch = semText.match(/<params>([\s\S]*?)<\/params>/);
      if (dataMatch) {
        const values = this.extractStringValues(dataMatch[1]);
        if (values.length > 0) {
          academicSemesterId = values[0];

          if (paramsMatch) {
            const pRegex = /<p>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/p>/g;
            const params: string[] = [];
            let pMatch;
            while ((pMatch = pRegex.exec(paramsMatch[1])) !== null) {
              params.push(pMatch[1].trim());
            }
            const nameIdx =
              params.indexOf("semesterName") !== -1
                ? params.indexOf("semesterName")
                : params.indexOf("semesterLongName");
            if (nameIdx !== -1 && values[nameIdx]) {
              semesterTitle = values[nameIdx];
            }
          }
        }
      }
    }

    if (!academicSemesterId) {
      throw new Error("Failed to retrieve current academic semester ID.");
    }

    // 4. Fetch timetable data
    const timetableBody = new URLSearchParams();
    timetableBody.set("userId", userId);
    timetableBody.set("userName", studentId);
    timetableBody.set("sessionId", sessionId);
    timetableBody.set("className", "StudentSubjectSetAdminBean");
    timetableBody.set("methodName", "getStudentSubjectSetListForTimeTable");

    // Construct rmiXML with the discovered IDs
    const rmiXML = `<maestroRMI><a t="s">${studentStubId}</a><a t="s">${studentStatusId}</a><a t="s">${academicSemesterId}</a><a t="AS"><a t="M" length="19"><a t="V" length="2"><a t="s">studentSubjectSetId</a><a t="s">studentSubjectSetId</a></a><a t="V" length="2"><a t="s">subjectSetInformation</a><a t="s">subjectSetInformation</a></a><a t="V" length="2"><a t="s">subjectAbbreviation</a><a t="s">subjectAbbreviation</a></a><a t="V" length="2"><a t="s">classAbbreviation</a><a t="s">classAbbreviation</a></a><a t="V" length="2"><a t="s">className</a><a t="s">className</a></a><a t="V" length="2"><a t="s">block</a><a t="s">block</a></a><a t="V" length="2"><a t="s">classSubjectSetId</a><a t="s">classSubjectSetId</a></a><a t="V" length="2"><a t="s">teacherName</a><a t="s">teacherName</a></a><a t="V" length="2"><a t="s">subjectName</a><a t="s">subjectName</a></a><a t="V" length="2"><a t="s">classSubjectSetCode</a><a t="s">classSubjectSetCode</a></a><a t="V" length="2"><a t="s">classSubjectSetName</a><a t="s">classSubjectSetName</a></a><a t="V" length="2"><a t="s">classSubjectSetIndex</a><a t="s">classSubjectSetIndex</a></a><a t="V" length="2"><a t="s">classSubjectSetNumberOfStudents</a><a t="s">classSubjectSetNumberOfStudents</a></a><a t="V" length="2"><a t="s">classSubjectSetCreditHours</a><a t="s">classSubjectSetCreditHours</a></a><a t="V" length="2"><a t="s">scheduleList</a><a t="s">scheduleList</a></a><a t="V" length="2"><a t="s">statusCode</a><a t="s">statusCode</a></a><a t="V" length="2"><a t="s">sequenceTimeTableDays</a><a t="s">sequenceTimeTableDays</a></a><a t="V" length="2"><a t="s">clashedSubjects</a><a t="s">clashedSubjects</a></a><a t="V" length="2"><a t="s">teacherMobilePhone</a><a t="s">teacherMobilePhone</a></a></a><a t="M" length="0"></a></a><a t="TableParameters"><tableId><a t="s">scheduleSubjectTable</a></tableId><userId><a t="s">${userId}</a></userId><width><a t="i">-1</a></width><height><a t="i">-1</a></height><columnWidths><a t="L" length="0"></a></columnWidths><sortColumn><a t="s">subjectName</a></sortColumn><sortOrder><a t="i">1</a></sortOrder><isInitialSort><a t="b">true</a></isInitialSort><pageNumber><a t="i">-1</a></pageNumber><maxResults><a t="i">-1</a></maxResults><numItemsPerPage><a t="i">2147483647</a></numItemsPerPage><sortColumn0><a t="null"/></sortColumn0><sortOrder0><a t="i">1</a></sortOrder0><sortColumn2><a t="null"/></sortColumn2><sortOrder2><a t="i">1</a></sortOrder2><sortColumn3><a t="null"/></sortColumn3><sortOrder3><a t="i">1</a></sortOrder3><previousPage><a t="i">-1</a></previousPage></a><a t="SearchParameters"><containsQueryMap><a t="M" length="0"></a></containsQueryMap><searchTypeQueryMap><a t="M" length="0"></a></searchTypeQueryMap><searchQuery><a t="null"/></searchQuery><orGroupConstraints><a t="M" length="0"></a></orGroupConstraints><returnDeletedRows><a t="b">false</a></returnDeletedRows><returnDistinctRows><a t="b">false</a></returnDistinctRows><switches><a t="M" length="0"></a></switches></a></maestroRMI>`;
    timetableBody.set("rmiXML", rmiXML);

    const timetableRes = await fetch(
      `${this.baseUrl}/servlet/com.maestro.servlet.FrontBeanController`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": this.userAgent,
          Authorization: `Bearer ${jwt}`,
        },
        body: timetableBody.toString(),
      },
    );

    const timetableText = await timetableRes.text();
    console.log("Timetable Response 1:", timetableText);

    if (
      timetableText.includes("status=false") ||
      !timetableText.includes("status=true")
    ) {
      throw new Error(
        "Failed to fetch timetable data. The API returned an error.",
      );
    }

    // Parse timetable XML response
    const result = this.parseTimetableXml(timetableText);
    if (semesterTitle && result.length > 0 && !result[0].title) {
      result[0].title = semesterTitle;
    }
    return result;
  }

  /**
   * Parse timetable data from MaestroRMI XML response.
   */
  private parseTimetableXml(xml: string): SemesterCalendar[] {
    const schedules: Schedule[] = [];

    // The response contains DataClass objects with course data
    // Each course has: subjectCode, subjectName, creditHours, set, etc.
    // along with schedule arrays containing day, time, venue

    // Extract the returnxml part - it's everything after returnxml= until the end or next parameter
    const returnXmlMatch = xml.match(/returnxml=([^&]*)/);
    if (!returnXmlMatch) return [{ title: null, schedules: [] }];

    const returnXml = decodeURIComponent(returnXmlMatch[1]);
    console.log("Decoded returnXml Length:", returnXml.length);

    // 1. Extract params to know the field order
    // Params are usually in a <params> block
    const paramsMatch = returnXml.match(/<params>([\s\S]*?)<\/params>/);
    const params: string[] = [];
    if (paramsMatch) {
      const pRegex = /<p>(?:<!\[CDATA\[)?([^<\]]*?)(?:\]\]>)?<\/p>/g;
      let pMatch;
      while ((pMatch = pRegex.exec(paramsMatch[1])) !== null) {
        params.push(pMatch[1].trim());
      }
    }
    console.log("Extracted Params:", params);

    if (params.length === 0) {
      // Fallback: search for <p> tags directly in the whole returnXml if <params> block not found
      const pRegex = /<p>(?:<!\[CDATA\[)?([^<\]]*?)(?:\]\]>)?<\/p>/g;
      let pMatch;
      while ((pMatch = pRegex.exec(returnXml)) !== null) {
        const p = pMatch[1].trim();
        // Skip if it looks like a value, not a param name (heuristic)
        if (p && !params.includes(p) && p.length < 50) {
          params.push(p);
        }
      }
      console.log("Fallback Extracted Params:", params);
    }

    // Indices for key fields
    const idx = {
      code: params.indexOf("subjectAbbreviation"),
      title: params.indexOf("subjectName"),
      credit: params.indexOf("classSubjectSetCreditHours"),
      instructor: params.indexOf("teacherName"),
      schedules: params.indexOf("scheduleList"),
    };
    console.log("Field Indices:", idx);

    // 2. Extract course entries (ValueObjectData)
    // We split by the tag and then parse the expected number of children
    const entriesSplit = returnXml.split('<a t="ValueObjectData">');
    entriesSplit.shift(); // Remove content before first entry

    for (const entryContent of entriesSplit) {
      const children: string[] = [];
      let i = 0;
      while (i < entryContent.length && children.length < params.length) {
        // Find next <a t=
        const nextA = entryContent.indexOf('<a t="', i);
        if (nextA === -1) break;

        // Find end of the start tag
        const startTagEnd = entryContent.indexOf(">", nextA);
        if (startTagEnd === -1) break;

        const tag = entryContent.substring(nextA, startTagEnd + 1);
        if (tag.endsWith("/>")) {
          // Self-closing
          children.push(tag);
          i = startTagEnd + 1;
        } else {
          // Paired tag - find matching </a>
          let depth = 1;
          let j = startTagEnd + 1;
          while (depth > 0 && j < entryContent.length) {
            const nextClose = entryContent.indexOf("</a>", j);
            const nextOpen = entryContent.indexOf('<a t="', j);

            if (nextClose === -1) break; // Should not happen in valid XML

            if (nextOpen !== -1 && nextOpen < nextClose) {
              // Check if it's self-closing
              const nextOpenEnd = entryContent.indexOf(">", nextOpen);
              const openTag = entryContent.substring(nextOpen, nextOpenEnd + 1);
              if (!openTag.endsWith("/>")) {
                depth++;
              }
              j = nextOpenEnd + 1;
            } else {
              depth--;
              if (depth === 0) {
                children.push(entryContent.substring(nextA, nextClose + 4));
                i = nextClose + 4;
              } else {
                j = nextClose + 4;
              }
            }
          }
        }
      }

      if (children.length < params.length) continue;

      const code = this.extractCData(children[idx.code] || "");
      const title = this.extractCData(children[idx.title] || "");
      const creditHours = parseFloat(
        children[idx.credit]?.replace(/<[^>]*>/g, "") || "0",
      );
      const instructor = this.extractCData(children[idx.instructor] || "");

      if (!code) continue;

      // Skip if course name indicates it's "DONE"
      if (title.toUpperCase().includes("DONE")) continue;

      // 3. Parse nested schedule list
      const scheduleListXml = children[idx.schedules] || "";
      const timeSlots: TimeSlot[] = [];
      let location = "";

      const mapRegex = /<dynamicMap>([\s\S]*?)<\/dynamicMap>/g;
      let mapMatch;
      while ((mapMatch = mapRegex.exec(scheduleListXml)) !== null) {
        const mapEntries = this.extractMapEntries(mapMatch[1]);

        const room = mapEntries.find((e) => e.key === "classRoom")?.value;
        if (room?.toUpperCase() === "DONE") continue;

        const dayStr = mapEntries.find((e) => e.key === "day")?.value;
        const startStr = mapEntries.find((e) => e.key === "startTime")?.value;
        const endStr = mapEntries.find((e) => e.key === "endTime")?.value;

        if (dayStr && startStr && endStr) {
          const day = this.mapDay(dayStr);
          if (day >= 0) {
            timeSlots.push({
              day,
              start: this.parseTime(startStr),
              end: this.parseTime(endStr),
            });
            if (room && !location.includes(room)) {
              location = location ? `${location}, ${room}` : room;
            }
          }
        }
      }

      if (timeSlots.length > 0) {
        schedules.push({
          code,
          title: title || "",
          creditHours: isNaN(creditHours) ? null : creditHours,
          section: null, // Scraper doesn't explicitly show section in this structure
          instructor: instructor || null,
          location: location || null,
          timeSlots,
        });
      }
    }

    // Try to extract semester title
    const sessionMatch = returnXml.match(
      /semesterLongName<\/p>[\s\S]*?<a t="s">(?:<!\[CDATA\[)?([^\]<]+)(?:\]\]>)?<\/a>/,
    );
    const semesterTitle = sessionMatch ? sessionMatch[1] : null;

    return [
      {
        title: semesterTitle,
        schedules,
      },
    ];
  }
}
