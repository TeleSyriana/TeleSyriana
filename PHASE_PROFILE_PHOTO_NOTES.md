# Profile Photo Upgrade

- Added profile photo upload in Settings top corner.
- Preview uses the same initials style as chat when no photo exists.
- Uploaded photo is compressed client-side and saved to `userProfiles/{userId}.profilePhoto`.
- The photo immediately updates:
  - Settings preview
  - Chat sidebar avatars
  - Chat message avatars
  - Home welcome area before the greeting
- If no photo is uploaded, the Home welcome photo stays hidden.
- Remove photo button clears the photo locally and in Firestore.
