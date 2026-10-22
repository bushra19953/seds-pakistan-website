import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface MissionState {
  activeMissions: number;
  totalChapters: number;
  liveMissions: any[];
  commandFeed: any[];
}

const initialState: MissionState = {
  activeMissions: 0,
  totalChapters: 0,
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
    },
    setChapterCount: (state, action: PayloadAction<number>) => {
      state.totalChapters = action.payload;
    }
  },
});

export const { setTelemetry, updateCommandFeed, updateLiveMissions, setChapterCount } = missionSlice.actions;
export default missionSlice.reducer;
