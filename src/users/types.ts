export interface CloudTesterProfile {
  tester_name: string;
  discord_username: string;
  state_country: string;
  country_city: string;
  isp: string;
  connection_type: string;
  normal_fortnite_ping_ms: number | null;
  normal_fortnite_packet_loss_pct: number | null;
  routelag_fortnite_ping_ms: number | null;
  routelag_fortnite_packet_loss_pct: number | null;
  johannesburg_fortnite_ping_ms: number | null;
  dallas_fortnite_ping_ms: number | null;
  fortnite_region: string;
  packet_loss_notes: string;
  best_route: string;
  any_issues: string;
  felt_smoother: string;
  internet_broke: string;
  end_optimization_worked: string;
  notes: string;
}

export interface CloudAppPreferences {
  openLastPage: boolean;
  checkEngineOnLaunch: boolean;
  confirmCloseOptimized: boolean;
  reduceAnimations: boolean;
}

export interface CloudUserDocument {
  testerId: string;
  inviteCode: string;
  profile: CloudTesterProfile;
  preferences: CloudAppPreferences;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

export const defaultCloudProfile = (): CloudTesterProfile => ({
  tester_name: "",
  discord_username: "",
  state_country: "",
  country_city: "",
  isp: "",
  connection_type: "",
  normal_fortnite_ping_ms: null,
  normal_fortnite_packet_loss_pct: null,
  routelag_fortnite_ping_ms: null,
  routelag_fortnite_packet_loss_pct: null,
  johannesburg_fortnite_ping_ms: null,
  dallas_fortnite_ping_ms: null,
  fortnite_region: "",
  packet_loss_notes: "",
  best_route: "",
  any_issues: "",
  felt_smoother: "",
  internet_broke: "",
  end_optimization_worked: "",
  notes: "",
});

export const defaultCloudPreferences = (): CloudAppPreferences => ({
  openLastPage: true,
  checkEngineOnLaunch: true,
  confirmCloseOptimized: true,
  reduceAnimations: false,
});
