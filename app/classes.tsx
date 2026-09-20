import React from "react";
import ClassroomHome from "../src/components/classroom/ClassroomHome";

// Month 6 — education pilot entry point. Deliberately a BARE route: every
// gate and every bit of logic lives in ClassroomHome
// (src/components/classroom/) or classroomService, never here — same
// reasoning as app/class/[id].tsx's own header (screens under app/ can't be
// render/import-tested in this Jest setup).
export default function ClassesScreen() {
  return <ClassroomHome />;
}
