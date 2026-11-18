import { describe, expect, it, vi } from "vitest";
import { handlePanel, type PanelRuntime } from "../src/panel";
import { itemTitleLink } from "../src/panel-kit";
import { EdPlugin } from "../src/plugins/campus/ed-plugin";
import { HttpStatusError } from "../src/plugins/http-error";
import { createTestDb } from "./support/sqlite-d1";

const THREAD = {
  thread: {
    id: 5001,
    number: 12,
    course_id: 100,
    user_id: 7,
    title: "Is Q3 graded on style?",
    category: "Assignments",
    document: "Asking for a friend.",
    answers: [
      {
        user_id: 9,
        document: "Yes, 10%.",
        created_at: "2026-11-05T10:00:00Z",
        is_endorsed: true,
        vote_count: 3,
        comments: [{ user_id: 7, document: "Thanks!", created_at: "2026-11-05T11:00:00Z", comments: [] }],
      },
    ],
    comments: [{ user_id: 0, is_anonymous: true, document: "Same question.", comments: [] }],
  },
  users: [
    { id: 7, name: "Sam Student", course_role: "student" },
    { id: 9, name: "Tara Tutor", course_role: "tutor" },
  ],
};

describe("EdPlugin.thread", () => {
  it("reads a thread with answers, nested comments and resolved authors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(THREAD));
    const view = await new EdPlugin({ token: "t", region: "au", fetch: fetcher }).thread(5001);

    expect(String(fetcher.mock.calls[0]![0])).toBe("https://edstem.org/api/threads/5001");
    expect(view).toMatchObject({
      title: "Is Q3 graded on style?",
      url: "https://edstem.org/au/courses/100/discussion/12",
      post: { author: "Sam Student", role: "student", body: "Asking for a friend." },
      answers: [{ author: "Tara Tutor", role: "tutor", endorsed: true, votes: 3, replies: [{ author: "Sam Student", body: "Thanks!" }] }],
      comments: [{ author: "Anonymous", role: null }],
    });
  });
});

describe("Ed thread links and reader", () => {
  it("links an Ed thread to the panel reader and anything else to its source", () => {
    expect(itemTitleLink({ source: "campus-ed", itemId: "thread:5001", url: "https://edstem.org/x", title: "Q" })).toBe('<a class="plain" href="/panel/ed/5001">Q</a>');
    expect(itemTitleLink({ source: "campus-moodle", itemId: "event:1", url: "https://m/x", title: "A1" })).toContain('target="_blank"');
    expect(itemTitleLink({ source: "campus-moodle", itemId: "event:1", url: null, title: "A1" })).toBe("A1");
  });

  async function page(edThread: PanelRuntime["edThread"]): Promise<string> {
    const db = await createTestDb();
    const runtime = { db, adminToken: "a", timezone: "UTC", now: () => new Date("2026-11-06T09:00:00Z"), ...(edThread ? { edThread } : {}) } as unknown as PanelRuntime;
    const response = await handlePanel(new Request("https://unicorn.example/panel/ed/5001"), runtime);
    expect(response.status).toBe(200);
    return response.text();
  }

  it("renders the thread inside the panel", async () => {
    const html = await page(async (id) => new EdPlugin({ token: "t", fetch: async () => Response.json(THREAD) }).thread(id));
    expect(html).toContain("Is Q3 graded on style?");
    expect(html).toContain("Yes, 10%.");
    expect(html).toContain("Endorsed");
    expect(html).toContain("1 answer");
    expect(html).toContain("Open in Ed");
  });

  it("says what went wrong when Ed is missing or refuses", async () => {
    expect(await page(undefined)).toContain("Ed isn't connected");
    expect(
      await page(async () => {
        throw new HttpStatusError(404, "gone");
      }),
    ).toContain("deleted or made private");
  });
});
