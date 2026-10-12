import { beforeEach, describe, expect, test, vi } from "vitest";
import { deriveLegacyEmbeddedData } from "@formbricks/types/embedded-data-resolver";
import type { TResponse } from "@formbricks/types/responses";
import { TSurveyElementTypeEnum } from "@formbricks/types/surveys/elements";
import type { TSurvey } from "@formbricks/types/surveys/types";
import { sendVerificationLinkEmail } from "./index";
import { buildSurveyResponseEmailHtml } from "./lib/survey-response-email";

const { sendMail, getTranslate, getElementResponseMapping } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  getTranslate: vi.fn(),
  getElementResponseMapping: vi.fn(),
}));

// Keep real templates/rendering; only replace transport, translation lookup and data services.
vi.mock("nodemailer", () => ({ createTransport: vi.fn(() => ({ sendMail })) }));
vi.mock("@/lingodotdev/server", () => ({ getTranslate }));
vi.mock("@/lib/organization/service", () => ({
  getOrganization: vi.fn(),
  getOrganizationByWorkspaceId: vi.fn(),
}));
vi.mock("@/lib/jwt", () => ({
  createEmailChangeToken: vi.fn(),
  createEmailToken: vi.fn(),
  createInviteToken: vi.fn(),
  createToken: vi.fn(),
  createTokenForLinkSurvey: vi.fn(),
}));
vi.mock("@/lib/responses", () => ({ getElementResponseMapping }));
vi.mock("@/modules/storage/utils", () => ({
  resolveStorageUrl: (url: string) => new URL(url, "https://surveys.example.test").toString(),
}));
vi.mock("@/lib/constants", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/constants");
  return {
    ...actual,
    WEBAPP_URL: "https://surveys.example.test",
    IS_SMTP_CONFIGURED: true,
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: 1025,
    MAIL_FROM: "noreply@example.test",
    PRIVACY_URL: "https://legal.example.test/privacy",
    IMPRINT_URL: "https://legal.example.test/imprint",
    IMPRINT_ADDRESS: "Example Legal Address",
  };
});

const baseUrl = "https://surveys.example.test";
const t = (key: string) => key;
const survey = {
  id: "cm9zr4mps000008l8btfy1vtz",
  blocks: [],
  languages: [],
  embeddedFields: deriveLegacyEmbeddedData({
    variables: [{ id: "plan", name: "Plan", type: "text", value: "" }],
    hiddenFields: { enabled: true, fieldIds: ["utm"] },
  }),
} as unknown as TSurvey;
const response = {
  id: "cm9zr4rsp000708l8bqccpfrx",
  surveyId: survey.id,
  data: { name: "Jane", utm: "newsletter" },
  variables: { plan: "Enterprise" },
  language: "en-US",
} as unknown as TResponse;

const expectLocalBranding = (html: string) => {
  expect(html).toContain(`src="${baseUrl}/logo-transparent.png"`);
  expect(html).toContain(`href="${baseUrl}?utm_source=email_header&amp;utm_medium=email"`);
  expect(html).toContain(`href="${baseUrl}/?utm_source=email_header&amp;utm_medium=email"`);
  expect(html).not.toContain("https://app.formbricks.com");
};

const expectLegalFooter = (html: string) => {
  expect(html).toContain("https://legal.example.test/privacy");
  expect(html).toContain("https://legal.example.test/imprint");
  expect(html).toContain("Example Legal Address");
};

describe("self-hosted email branding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMail.mockResolvedValue(undefined);
    getTranslate.mockResolvedValue(t);
    getElementResponseMapping.mockReturnValue([
      { element: "Favorite fruit", response: "Banana", type: TSurveyElementTypeEnum.OpenText },
    ]);
  });

  test("verification sender renders instance branding without changing the Better Auth verification link", async () => {
    const verifyLink = "https://auth.example.test/api/auth/verify-email?token=verification-token";
    await expect(
      sendVerificationLinkEmail({ email: "user@example.test", locale: "de-DE", verifyLink })
    ).resolves.toBe(true);

    expect(getTranslate).toHaveBeenCalledWith("de-DE");
    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0][0];
    expect(mail).toMatchObject({ to: "user@example.test", subject: "emails.verification_email_subject" });
    expectLocalBranding(mail.html);
    expectLegalFooter(mail.html);
    // The verify CTA, fallback link and resend CTA all retain Better Auth's exact link.
    expect(mail.html.split(`href="${verifyLink}"`)).toHaveLength(4);
  });

  test("shared followup/workflow renderer keeps instance branding, recall and sanitization", async () => {
    const html = await buildSurveyResponseEmailHtml({
      body: '<p>Hello #recall:name/fallback:friend#</p><script>alert("unsafe")</script>',
      survey,
      response,
      attachResponseData: false,
      locale: "de-DE",
    });

    expectLocalBranding(html);
    expectLegalFooter(html);
    expect(getTranslate).toHaveBeenCalledWith("de-DE");
    expect(html).toContain("Hello Jane");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("unsafe");
    expect(getElementResponseMapping).not.toHaveBeenCalled();
  });

  test("shared followup/workflow renderer preserves custom logos and attached response blocks", async () => {
    const html = await buildSurveyResponseEmailHtml({
      body: "<p>Response received</p>",
      survey,
      response,
      attachResponseData: true,
      includeVariables: true,
      includeHiddenFields: true,
      logoUrl: "/storage/workspace/public/custom-logo.png",
    });

    expect(html).toContain(`src="${baseUrl}/storage/workspace/public/custom-logo.png"`);
    expect(html).not.toContain("logo-transparent.png");
    expect(html).not.toContain("emails.email_template_text_1");
    expect(html).not.toContain("https://app.formbricks.com");
    expectLegalFooter(html);
    expect(html).toContain("Favorite fruit");
    expect(html).toContain("Banana");
    expect(html).toContain("Plan");
    expect(html).toContain("Enterprise");
    expect(html).toContain("newsletter");
  });
});
