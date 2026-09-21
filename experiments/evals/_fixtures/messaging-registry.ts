// Shared 27-tool registry fixture used by select-vs-selfselect.ts and
// select-ambiguity.ts, so both tests compare against the identical toolset.
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface CandidateTool {
  name: string;
  description: string;
  useWhen: string[];
  avoidWhen: string[];
  relevant: boolean;
}

export const CORRECT_TOOL = "send_slack_message";

export const CANDIDATES: CandidateTool[] = [
  { name: "send_slack_message", description: "Post a message to a Slack channel.", useWhen: ["The task asks to notify or post in Slack or a team channel"], avoidWhen: ["No Slack channel is mentioned"], relevant: true },
  // Near-misses: same domain (team notification), deliberately plausible.
  { name: "send_email", description: "Send an email message to one or more recipients.", useWhen: ["The task asks to email someone"], avoidWhen: ["No email recipient is mentioned"], relevant: false },
  { name: "send_sms", description: "Send a text message via SMS to a phone number.", useWhen: ["The task asks to text or SMS a phone number"], avoidWhen: ["No phone number or SMS is mentioned"], relevant: false },
  { name: "post_to_teams", description: "Post a message to a Microsoft Teams channel.", useWhen: ["The task asks to post in Microsoft Teams"], avoidWhen: ["The task specifies a different platform"], relevant: false },
  { name: "create_calendar_invite", description: "Create a calendar invite and send it to attendees.", useWhen: ["The task asks to schedule a meeting or send an invite"], avoidWhen: ["No meeting or invite is requested"], relevant: false },
  // Unrelated decoys, padding to a realistic large registry.
  { name: "query_database", description: "Run a read-only SQL query against the production analytics database.", useWhen: ["The task asks for stored data"], avoidWhen: ["No data query is needed"], relevant: false },
  { name: "deploy_to_prod", description: "Trigger a production deployment of the current build.", useWhen: ["The task explicitly asks to deploy"], avoidWhen: ["No deployment is requested"], relevant: false },
  { name: "generate_pdf_report", description: "Render a structured report as a downloadable PDF.", useWhen: ["The task asks for a PDF"], avoidWhen: ["No document generation is requested"], relevant: false },
  { name: "convert_currency", description: "Convert an amount between two currencies at the current exchange rate.", useWhen: ["A monetary amount needs currency conversion"], avoidWhen: ["No currency conversion is needed"], relevant: false },
  { name: "create_support_ticket", description: "File a new ticket in the support/ticketing system.", useWhen: ["The task asks to file or track a support issue"], avoidWhen: ["No ticket is requested"], relevant: false },
  { name: "check_service_uptime", description: "Query current uptime and incident status for a monitored service.", useWhen: ["The task asks about service health or incidents"], avoidWhen: ["No monitoring question is asked"], relevant: false },
  { name: "trigger_backup", description: "Start an on-demand backup of a named database or volume.", useWhen: ["The task asks to back something up"], avoidWhen: ["No backup is requested"], relevant: false },
  { name: "update_dns_record", description: "Create or update a DNS record for a domain.", useWhen: ["The task asks to change DNS"], avoidWhen: ["No DNS change is requested"], relevant: false },
  { name: "renew_tls_certificate", description: "Renew a TLS certificate for a domain.", useWhen: ["The task asks about certificate renewal"], avoidWhen: ["No certificate action is requested"], relevant: false },
  { name: "encrypt_file", description: "Encrypt a file with a given key.", useWhen: ["The task asks to encrypt a file"], avoidWhen: ["No encryption is requested"], relevant: false },
  { name: "resize_image", description: "Resize an image to given dimensions.", useWhen: ["The task asks to resize an image"], avoidWhen: ["No image is involved"], relevant: false },
  { name: "transcode_video", description: "Convert a video file to a different format or bitrate.", useWhen: ["The task asks to transcode video"], avoidWhen: ["No video is involved"], relevant: false },
  { name: "translate_text", description: "Translate text from one language to another.", useWhen: ["The task asks for translation"], avoidWhen: ["No translation is needed"], relevant: false },
  { name: "analyze_sentiment", description: "Score the sentiment of a piece of text.", useWhen: ["The task asks for sentiment analysis"], avoidWhen: ["No sentiment analysis is requested"], relevant: false },
  { name: "generate_invoice", description: "Generate an invoice for a customer and amount.", useWhen: ["The task asks to invoice a customer"], avoidWhen: ["No billing is requested"], relevant: false },
  { name: "run_payroll", description: "Process payroll for the current pay period.", useWhen: ["The task asks to run payroll"], avoidWhen: ["No payroll action is requested"], relevant: false },
  { name: "check_inventory", description: "Look up current stock level for a SKU.", useWhen: ["The task asks about inventory or stock levels"], avoidWhen: ["No inventory question is asked"], relevant: false },
  { name: "generate_shipping_label", description: "Generate a shipping label for a package.", useWhen: ["The task asks to ship a package"], avoidWhen: ["No shipping is requested"], relevant: false },
  { name: "get_weather", description: "Look up the current weather for a location.", useWhen: ["The task asks about weather"], avoidWhen: ["No weather question is asked"], relevant: false },
  { name: "get_stock_price", description: "Look up the current price of a stock ticker.", useWhen: ["The task asks about a stock price"], avoidWhen: ["No stock price question is asked"], relevant: false },
  { name: "schedule_meeting", description: "Find a free slot and schedule a meeting between attendees.", useWhen: ["The task asks to schedule a meeting"], avoidWhen: ["No meeting scheduling is requested"], relevant: false },
  { name: "lookup_contact", description: "Look up a contact's details in the company directory.", useWhen: ["The task asks to find someone's contact info"], avoidWhen: ["No contact lookup is requested"], relevant: false },
];

export function makeStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: CANDIDATES.find((c) => c.name === name)?.description ?? name,
    parameters: { type: "object", properties: { message: { type: "string" } } } as never,
    execute: async () => ({ content: [{ type: "text", text: `${name}: done` }], details: {} }),
  };
}
