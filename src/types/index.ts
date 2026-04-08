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
  inviteCode: string;
  members: string[];
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

export interface TextElement {
  id: string;
  boardId: string;
  userId: string;
  text: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  fontSize: number;
  color: string;
  createdAt: Date;
}
