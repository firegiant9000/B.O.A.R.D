import React from "react";
import { useLocalSearchParams } from "expo-router";
import InstructorCohortGrid from "../../src/components/classroom/InstructorCohortGrid";

// Month 6 — education pilot instructor cohort grid (ROADMAP.md Appendix E.2
// "Cohort views"). Deliberately a BARE route: every gate and every bit of
// data-fetching logic lives in InstructorCohortGrid
// (src/components/classroom/) or classroomService, never here — see this
// task's R80 ruling. Screens under app/ can't be render/import-tested in
// this Jest setup (expo-font is unresolvable via @expo/vector-icons, and
// @firebase/util ships ESM the transform doesn't handle), and expo-router
// route files aren't platform-excluded from a native bundle even with a
// `.web` extension — so the tested surface is always the component this
// file does nothing but render.
export default function ClassCohortScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <InstructorCohortGrid classId={id ?? ""} />;
}
