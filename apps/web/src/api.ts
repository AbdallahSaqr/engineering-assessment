import type { ApplicationStatus, ApplicationView } from "@assessment/contracts";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3001";
const demoCustomerId = process.env.DEMO_CUSTOMER_ID ?? "cus_amina_001";

export async function fetchApplication(
  applicationId: string,
): Promise<ApplicationView> {
  const response = await fetch(`${apiUrl}/v1/applications/${applicationId}`, {
    cache: "no-store",
    headers: { "x-customer-id": demoCustomerId },
  });

  if (!response.ok) {
    throw new Error(`Application request failed with ${response.status}`);
  }

  return (await response.json()) as ApplicationView;
}

export function formatStatus(status: ApplicationStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
