'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useUser } from '@/firebase';
import { useFirestore, useCollection } from '@/firebase';
import { collection, query, where, orderBy, doc, onSnapshot, Timestamp, getDoc } from 'firebase/firestore';
import { useSafeFirestoreSubscription } from '@/hooks/use-safe-firestore-subscription';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { orderBy as firestoreOrderBy } from 'firebase/firestore';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { format, formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import {
  MessageCircle,
  Send,
  Users,
  Clock,
  CheckCircle,
  AlertCircle,
  Activity,
  Eye,
  Paperclip,
  MoreHorizontal,
  Check,
  CheckCheck,
  Loader2
} from 'lucide-react';
import { EnhancedMediationMessage } from '@/lib/task-types';
import { addDoc, setDoc, updateDoc } from '@/lib/client/firestore-wrapper';


interface EnhancedWorkflowChatProps {
  workflowId: string;
  workflowTitle: string;
  taskId?: string; // Optional taskId for task-specific messages
  className?: string;
  showHeader?: boolean;
  participants: string[];
  enabled?: boolean;
}

interface TypingIndicator {
  userId: string;
  userName: string;
  isTyping: boolean;
  lastActivity: Date;
}

interface PresenceStatus {
  userId: string;
  userName: string;
  userPhoto?: string;
  isOnline: boolean;
  lastSeen: Date;
  currentStep?: number;
}

interface UserProfile {
  name: string;
  photoURL?: string;
}

function EnhancedWorkflowChat({
  workflowId,
  workflowTitle,
  taskId,
  className = '',
  showHeader = true,
  participants = [],
  enabled = false
}: EnhancedWorkflowChatProps) {
  const { user } = useUser();
  const firestore = useFirestore();
  const { showToast: toast } = useEnhancedToast();
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<EnhancedMediationMessage[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingIndicator[]>([]);
  const [presence, setPresence] = useState<PresenceStatus[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [userProfiles, setUserProfiles] = useState<Record<string, UserProfile>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout>();
  const inputRef = useRef<HTMLInputElement>(null);
  const warnPresenceRef = useRef<boolean>(false);
  const warnTypingRef = useRef<boolean>(false);
  const envRealtimeRaw = process.env.NEXT_PUBLIC_REALTIME_ENABLED;
  const enableRealtimeEnv = envRealtimeRaw === undefined || String(envRealtimeRaw).toLowerCase() === 'true';
  const allowRealtime = (enabled || enableRealtimeEnv);
  const [isOpen, setIsOpen] = useState(allowRealtime);

  useEffect(() => {
    if (process.env.NODE_ENV === 'development' && allowRealtime) {
      console.log(`[EnhancedWorkflowChat] Real-time chat enabled for workflow: ${workflowId}`);
    }
  }, [allowRealtime, workflowId]);
  const handleSnapshotError = useCallback((e: any) => {
    try {
      const code = String((e && e.code) || '');
      if (code === 'permission-denied') {
        toast({ variant: 'destructive', title: 'Access Restricted', description: 'You do not have permission to view realtime data for this workflow.' });
        setIsOpen(false);
      }
    } catch { }
  }, [toast]);

  const stableParticipantsKey = useMemo(() => {
    const set = Array.from(new Set(participants || []));
    set.sort();
    return JSON.stringify(set);
  }, [participants]);
  const stableParticipants = useMemo(() => JSON.parse(stableParticipantsKey || '[]') as string[], [stableParticipantsKey]);



  // Auto-join workflow if not a member (self-healing for existing tasks)
  useEffect(() => {
    if (!firestore || !workflowId || !user?.uid) return;

    const ensureMembership = async () => {
      try {
        const memberId = `${workflowId}_${user.uid}`;
        const memberRef = doc(firestore, 'workflow_members', memberId);
        const snap = await getDoc(memberRef);

        if (!snap.exists()) {
          console.log('[EnhancedWorkflowChat] Auto-joining workflow:', workflowId);
          await setDoc(memberRef, {
            workflowId,
            userId: user.uid,
            joinedAt: Timestamp.now(),
            role: 'member'
          });
        }
      } catch (e) {
        console.warn('[EnhancedWorkflowChat] Failed to ensure membership:', e);
      }
    };

    ensureMembership();
  }, [firestore, workflowId, user?.uid]);

  // Query for workflow messages
  const messagesQuery = useMemoFirebase(() => {
    if (!firestore || !workflowId || !user?.uid) return null as any;
    const baseQuery = query(
      collection(firestore, 'messages'),
      where('workflowId', '==', workflowId),
      where('participantIds', 'array-contains', user.uid),
      orderBy('createdAt', 'asc')
    );
    // Always show all workflow messages to prevent fragmentation
    // return taskId ? query(baseQuery, where('taskId', '==', taskId)) : baseQuery;
    return baseQuery;
  }, [firestore, workflowId, user?.uid]);

  const { data: messagesData, loading: messagesLoading } = useCollection(messagesQuery, { listen: allowRealtime && isOpen });

  // Remove potentially-permissioned tasks query to avoid read failures for non-participant steps
  const wfTasks: any[] | null = null;

  const typingKey = useMemo(() => {
    if (!allowRealtime || !isOpen || !workflowId || !user?.uid) return '';
    if (!stableParticipants.length || !stableParticipants.includes(user.uid)) return '';
    const ids = stableParticipants.slice(0, 10).join(',');
    return `typing:${workflowId}:${ids}`;
  }, [allowRealtime, isOpen, workflowId, user?.uid, stableParticipantsKey]);

  useEffect(() => {
    if (!typingKey || !firestore) return;
    const ids = stableParticipants.slice(0, 10);
    const base = [where('workflowId', '==', workflowId)];
    const q = ids.length ? query(collection(firestore, 'workflow_typing'), ...base, where('userId', 'in', ids)) : query(collection(firestore, 'workflow_typing'), ...base);
    const unsub = onSnapshot(q, (snap) => {
      const now = Date.now();
      const list: TypingIndicator[] = [];
      snap.forEach((d) => {
        const data: any = d.data();
        const ts = data?.updatedAt?.toDate?.() || (data?.updatedAt ? new Date(data.updatedAt) : new Date());
        const fresh = now - ts.getTime() < 3000;
        if (data?.isTyping && fresh) {
          list.push({ userId: String(data.userId || ''), userName: String(data.userName || ''), isTyping: true, lastActivity: ts });
        }
      });
      setTypingUsers(list);
    }, handleSnapshotError);
    return () => unsub();
  }, [typingKey, firestore, workflowId, handleSnapshotError, stableParticipantsKey]);

  // Fetch user names and photos for display
  useEffect(() => {
    const fetchUserProfiles = async () => {
      const uniqueUserIds = Array.from(new Set([
        ...stableParticipants,
        ...(messagesData || []).map(msg => msg.senderId)
      ])).filter(Boolean);

      const profiles: Record<string, UserProfile> = {};
      for (const userId of uniqueUserIds) {
        try {
          const userDocRef = doc(firestore, 'users', userId);
          const snap = await getDoc(userDocRef);
          const data: any = snap.data();
          if (data) {
            profiles[userId] = {
              name: data.displayName || data.email || userId,
              photoURL: data.photoURL || undefined
            };
          }
        } catch (error) {
          profiles[userId] = { name: userId };
        }
      }

      setUserProfiles(profiles);
    };

    if ((allowRealtime && isOpen) && (participants.length > 0 || (messagesData && messagesData.length > 0))) {
      fetchUserProfiles();
    }
  }, [stableParticipantsKey, messagesData, firestore, allowRealtime, isOpen]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messagesData]);

  // Update presence when users become active/inactive
  useEffect(() => {
    if (!allowRealtime || !isOpen || !firestore || !workflowId || !user) return;
    if (!stableParticipants.length || !stableParticipants.includes(user.uid)) return;
    const id = `${workflowId}_${user.uid}`;
    const ref = doc(firestore, 'workflow_presence', id);
    const updateOnline = async () => {
      try {
        await setDoc(ref, {
          workflowId,
          userId: user.uid,
          userName: user.displayName || userProfiles[user.uid]?.name || 'You',
          userPhoto: user.photoURL || userProfiles[user.uid]?.photoURL,
          isOnline: true,
          lastSeen: Timestamp.now(),
        }, { merge: true });
      } catch (e) {
        if (!warnPresenceRef.current) {
          warnPresenceRef.current = true;
          toast({ variant: 'destructive', title: 'Presence Unavailable', description: 'Unable to update presence. Your chat will still work.' });
        }
      }
    };
    const heartbeat = setInterval(updateOnline, 30000);
    updateOnline();
    const handleBeforeUnload = async () => {
      try {
        await setDoc(ref, { isOnline: false, lastSeen: Timestamp.now() }, { merge: true });
      } catch { }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [firestore, workflowId, user, userProfiles, allowRealtime, isOpen]);

  const presenceKey = useMemo(() => {
    if (!allowRealtime || !isOpen || !workflowId || !user?.uid) return '';
    if (!stableParticipants.length || !stableParticipants.includes(user.uid)) return '';
    const ids = stableParticipants.slice(0, 10).join(',');
    return `presence:${workflowId}:${ids}`;
  }, [allowRealtime, isOpen, workflowId, user?.uid, stableParticipantsKey]);

  useEffect(() => {
    if (!presenceKey || !firestore) return;
    const ids = stableParticipants.slice(0, 10);
    const base = [where('workflowId', '==', workflowId)];
    const q = ids.length ? query(collection(firestore, 'workflow_presence'), ...base, where('userId', 'in', ids)) : query(collection(firestore, 'workflow_presence'), ...base);
    const unsub = onSnapshot(q, (snap) => {
      const list: PresenceStatus[] = [];
      snap.forEach((d) => {
        const data: any = d.data();
        const last = data?.lastSeen?.toDate?.() || (data?.lastSeen ? new Date(data.lastSeen) : new Date());
        list.push({
          userId: String(data.userId || ''),
          userName: String(data.userName || ''),
          userPhoto: data.userPhoto,
          isOnline: !!data.isOnline,
          lastSeen: last,
          currentStep: Number(data.currentStep || 0)
        });
      });
      setPresence(list);
    }, handleSnapshotError);
    return () => unsub();
  }, [presenceKey, firestore, workflowId, handleSnapshotError, stableParticipantsKey]);

  const handleTyping = useCallback(() => {
    if (!user || isTyping || !allowRealtime || !isOpen) return;

    setIsTyping(true);

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    const id = `${workflowId}_${user.uid}`;
    const ref = doc(firestore, 'workflow_typing', id);
    setDoc(ref, { workflowId, userId: user.uid, userName: user.displayName || 'You', isTyping: true, updatedAt: Timestamp.now() }, { merge: true })
      .catch(() => {
        if (!warnTypingRef.current) {
          warnTypingRef.current = true;
          toast({ variant: 'destructive', title: 'Typing Indicator Failed', description: 'Unable to broadcast typing status.' });
        }
      });
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      setDoc(ref, { isTyping: false, updatedAt: Timestamp.now() }, { merge: true }).catch(() => { });
    }, 3000);
  }, [user, isTyping, firestore, workflowId, allowRealtime, isOpen]);

  const sendMessage = async () => {
    if (!user || !message.trim() || !allowRealtime || !isOpen) return;
    if (!participants || !participants.includes(user.uid)) return;

    try {
      const currentIndex = null as any;
      const targetTaskTitle = null as any;
      const participantIds = Array.from(new Set([
        ...(stableParticipants || []),
        user.uid
      ].filter(Boolean)));
      const messageData: any = {
        taskId: taskId || null,
        workflowId,
        senderId: user.uid,
        senderName: user.displayName || userProfiles[user.uid]?.name || user.uid,
        message: message.trim(),
        createdAt: Timestamp.now(),
        participantIds,
        workflowContext: {
          workflowTitle,
          currentStep: currentIndex >= 0 ? currentIndex : null,
          taskTitle: targetTaskTitle
        }
      };

      try {
        await addDoc(collection(firestore, 'messages'), messageData);
      } catch (e) {
        try {
          const idToken = await user.getIdToken(true);
          await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify(messageData),
          });
        } catch (e2) {
          throw e2;
        }
      }
      setMessage('');
      setIsTyping(false);

      toast({
        title: "Message Sent",
        description: "Your message has been sent to all workflow participants.",
      });
    } catch (error) {
      console.error('Error sending message:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to send message. Please try again.",
      });
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const getMessageStatusIcon = (message: any) => {
    // Only show status for messages sent by current user
    if (message.senderId !== user?.uid) return null;

    const messageTime = message.createdAt?.toDate?.() || new Date(message.createdAt);
    const now = Date.now();
    const messageAge = now - messageTime.getTime();

    // Sending state (< 2 seconds old)
    if (messageAge < 2000) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">Sending...</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    // Sent state (2-10 seconds old)
    if (messageAge < 10000) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Check className="h-3 w-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">Sent</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    // Delivered state (> 10 seconds old)
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <CheckCheck className="h-3 w-3 text-green-500" />
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">Delivered</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const formatMessageTime = (timestamp: any) => {
    const date = timestamp?.toDate?.() || new Date(timestamp);
    const now = new Date();
    const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffInHours < 24) {
      return format(date, 'HH:mm');
    }
    return format(date, 'MMM dd, HH:mm');
  };

  if (messagesLoading && isOpen) {
    return (
      <Card className={`min-h-[300px] max-h-[60vh] ${className}`}>
        <CardContent className="flex items-center justify-center h-full">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={`min-h-[120px] max-h-[60vh] flex flex-col ${className}`}>
      {!isOpen && (
        <CardHeader className="py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">{workflowTitle}</CardTitle>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setIsOpen(true)}>Open Chat</Button>
          </div>
        </CardHeader>
      )}
      {isOpen && (
        <>
          {showHeader && (
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageCircle className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-lg">{workflowTitle}</CardTitle>
                    <CardDescription className="flex items-center gap-2">
                      <Users className="h-3 w-3" />
                      <span>{participants.length} participants</span>
                      <Activity className="h-3 w-3" />
                      <span>{presence.filter(p => p.isOnline).length} online</span>
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {presence.slice(0, 3).map((user) => (
                    <TooltipProvider key={user.userId}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link href={`/profile/unified?uid=${user.userId}`}>
                            <Avatar className="h-6 w-6 hover:opacity-80 transition-opacity">
                              <AvatarImage src={user.userPhoto} alt={user.userName} />
                              <AvatarFallback className="text-xs">
                                {user.userName.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs">{user.userName}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ))}
                  {presence.length > 3 && (
                    <Badge variant="secondary" className="h-6 w-6 p-0 text-xs">
                      +{presence.length - 3}
                    </Badge>
                  )}
                </div>
              </div>
            </CardHeader>
          )}

          <Separator />

          <CardContent className="flex-1 flex flex-col p-0">
            {/* Messages Area */}
            <ScrollArea className="flex-1 px-4 py-3">
              <div className="space-y-4">
                {messagesData && messagesData.length > 0 ? (
                  messagesData.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex items-start gap-3 ${msg.senderId === user?.uid ? 'flex-row-reverse' : ''
                        }`}
                    >
                      <Link href={`/profile/unified?uid=${msg.senderId}`} className="flex-shrink-0">
                        <Avatar className="h-8 w-8 hover:opacity-80 transition-opacity">
                          <AvatarImage src={userProfiles[msg.senderId]?.photoURL} alt={userProfiles[msg.senderId]?.name || msg.senderId} />
                          <AvatarFallback className="text-xs">
                            {(userProfiles[msg.senderId]?.name || msg.senderId).charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </Link>

                      <div className={`flex-1 min-w-0 ${msg.senderId === user?.uid ? 'text-right' : ''
                        }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <Link href={`/profile/unified?uid=${msg.senderId}`} className="text-sm font-medium hover:underline">
                            {userProfiles[msg.senderId]?.name || msg.senderId}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {formatMessageTime(msg.createdAt)}
                          </span>
                          {getMessageStatusIcon(msg)}
                        </div>

                        <div className={`rounded-lg px-3 py-2 max-w-[80%] ${msg.senderId === user?.uid
                          ? 'bg-primary text-primary-foreground ml-auto'
                          : 'bg-muted'
                          }`}>
                          <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
                        </div>

                        {msg.workflowContext && (
                          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                            <Eye className="h-3 w-3" />
                            <span>Step {msg.workflowContext.currentStep + 1}</span>
                            {msg.workflowContext.taskTitle && (
                              <>
                                <span>•</span>
                                <span>{msg.workflowContext.taskTitle}</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No messages yet. Start the conversation!</p>
                  </div>
                )}

                {/* Typing Indicators */}
                {typingUsers.length > 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <div className="flex space-x-1">
                      <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                      <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                      <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"></div>
                    </div>
                    <span>
                      {typingUsers.map(t => t.userName).join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
                    </span>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            <Separator />

            {/* Message Input */}
            <div className="p-4">
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Input
                    ref={inputRef}
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value);
                      handleTyping();
                    }}
                    onKeyPress={handleKeyPress}
                    placeholder={`Message ${workflowTitle}...`}
                    className="pr-12"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-8 w-8 p-0"
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  onClick={sendMessage}
                  disabled={!message.trim()}
                  size="sm"
                  className="px-3"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>

              {/* Online Status */}
              <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-2 cursor-help">
                        <div className="flex items-center gap-1">
                          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                          <span>{presence.filter(p => p.isOnline).length} online</span>
                        </div>
                        <div className="flex -space-x-1">
                          {presence.filter(p => p.isOnline).slice(0, 3).map((user) => (
                            <Avatar key={user.userId} className="h-5 w-5 border-2 border-background">
                              <AvatarImage src={user.userPhoto} alt={user.userName} />
                              <AvatarFallback className="text-[10px] bg-primary/20 text-primary">
                                {user.userName.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                          ))}
                          {presence.filter(p => p.isOnline).length > 3 && (
                            <div className="h-5 w-5 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[10px]">
                              +{presence.filter(p => p.isOnline).length - 3}
                            </div>
                          )}
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-1">
                        <p className="font-semibold">Online Now:</p>
                        {presence.filter(p => p.isOnline).length > 0 ? (
                          presence.filter(p => p.isOnline).map((user) => (
                            <p key={user.userId} className="text-xs flex items-center gap-1">
                              <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
                              {user.userName}
                            </p>
                          ))
                        ) : (
                          <p className="text-xs text-muted-foreground">No one online</p>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>Real-time updates enabled</span>
                </div>
              </div>
            </div>
          </CardContent>
        </>
      )}
    </Card>
  );
}

export default EnhancedWorkflowChat;
