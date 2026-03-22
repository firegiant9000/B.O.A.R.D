export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAt: Date;
}

export interface Board {
  id: string;
  title: string;
  ownerId: string;
  collaboratorIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DrawPath {
  id: string;
  boardId: string;
  userId: string;
  points: { x: number; y: number }[];
  color: string;
  strokeWidth: number;
  tool: "pen" | "eraser";
  createdAt: Date;
}

export interface Session {
  id: string;
  boardId: string;
  title: string;
  description: string;
  scheduledAt: Date;
  durationMinutes: number;
  createdById: string;
  participantIds: string[];
  createdAt: Date;
}

export interface TextNote {
  id: string;
  boardId: string;
  userId: string;
  content: string;
  position: { x: number; y: number };
  createdAt: Date;
}
