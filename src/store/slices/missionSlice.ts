import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface MissionState {
  activeMissions: number;
  totalChapters: number;
  globalSyncLevel: number;
  readinessIndex: number;
  liveMissions: any[];
  commandFeed: any[];
}

const initialState: MissionState = {
  activeMissions: 0,
  totalChapters: 0,
  globalSyncLevel: 0,
  readinessIndex: 0,
  liveMissions: [],
  commandFeed: [],
};

export const missionSlice = createSlice({
  name: 'mission',
  initialState,
  reducers: {
    setTelemetry: (state, action: PayloadAction<Partial<MissionState>>) => {
      return { ...state, ...action.payload };
    },
    updateCommandFeed: (state, action: PayloadAction<any[]>) => {
      state.commandFeed = action.payload;
    },
    updateLiveMissions: (state, action: PayloadAction<any[]>) => {
      state.liveMissions = action.payload;
      state.activeMissions = action.payload.length;
      // Calculate readiness index based on active missions
      const totalPoints = action.payload.reduce((acc, curr) => acc + (curr.points || 0), 0);
      state.readinessIndex = Math.min(100, Math.max(0, (totalPoints / 100) * 10)); // Arbitrary formula for sci-fi feel
    },
    setChapterCount: (state, action: PayloadAction<number>) => {
      state.totalChapters = action.payload;
      state.globalSyncLevel = Math.min(100, action.payload * 5); // Example calculation
    }
  },
});

export const { setTelemetry, updateCommandFeed, updateLiveMissions, setChapterCount } = missionSlice.actions;
export default missionSlice.reducer;
