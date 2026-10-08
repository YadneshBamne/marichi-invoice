// Mandatory grievance-redressal disclosure (PRD Module 16): the grievance officer's contact and the escalation path.
// Values come from the environment so legal can set the real ones without a code change. Defaults are loud placeholders.
export const grievanceOfficer = () => ({
  name: process.env.GRIEVANCE_OFFICER_NAME ?? "TO BE CONFIGURED",
  email: process.env.GRIEVANCE_OFFICER_EMAIL ?? "TO BE CONFIGURED",
  phone: process.env.GRIEVANCE_OFFICER_PHONE ?? "TO BE CONFIGURED",
  address: process.env.GRIEVANCE_OFFICER_ADDRESS ?? "TO BE CONFIGURED",
});

export const isGrievanceConfigured = () => Object.values(grievanceOfficer()).every((v) => v !== "TO BE CONFIGURED");

// ponytail: Ombudsman details are jurisdiction-specific; confirm with counsel for the launch geography.
export const OMBUDSMAN = {
  name: "RBI Integrated Ombudsman Scheme",
  url: "https://cms.rbi.org.in",
  when: "if your complaint is not resolved within 30 days, or you are not satisfied with our reply",
};

export const ESCALATION_MATRIX = [
  { level: 1, who: "Customer support", within: "Acknowledged within 24 hours" },
  { level: 2, who: "Relationship manager", within: "Automatically escalated if the ticket breaches its resolution time" },
  { level: 3, who: "Credit / compliance team", within: "Automatically escalated if still unresolved at level 2" },
  { level: 4, who: "Grievance officer, then the Ombudsman", within: "Grievances: resolution within 30 days" },
];
