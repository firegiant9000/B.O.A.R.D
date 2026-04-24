# Proposal Repository Summary

## Project
- Repo: cmps-357-sp26-final-project-cmps357-team2
- Description: Repository URL: https://github.com/School-of-Computing-and-Informatics/cmps-357-sp26-

## Proposed Tech Stack / Architecture
- React Native
- Firebase

## Major Features Planned
- Deliver shared collaborative boards where users can draw, place notes, and organize ideas in real time.
- Connect each board to planning tools so teams can create and manage scheduled work sessions tied to board content.
- Persist board state, notes, and scheduling metadata for multi-user collaboration across devices.
- Include optional AI-assisted support for idea grouping or planning suggestions after core whiteboard and scheduling flows are stable.


## Data Structures / Algorithms Proposed
- Boards are stored as document-style records containing canvas objects (strokes, notes, positions) keyed by board id.
- Spatial indexing by object id and layer is used to update or redraw only changed elements during collaboration.
- Operational ordering (timestamp/version based) is used to merge concurrent edits in a predictable way.
- Session scheduling uses sorted datetime collections so upcoming sessions can be queried and displayed quickly per board.
- Optional AI grouping uses text clustering over note content to suggest related idea buckets and planning themes.

