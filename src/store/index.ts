import { configureStore } from '@reduxjs/toolkit';
import missionReducer from './slices/missionSlice';

export const store = configureStore({
  reducer: {
    mission: missionReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false, // Allow Firebase dates if needed, though best to serialize
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
