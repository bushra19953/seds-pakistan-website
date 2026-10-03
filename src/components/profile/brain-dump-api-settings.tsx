"use client";

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Eye, EyeOff, Key, Save, Trash2, CheckCircle, AlertCircle, Sparkles, Cpu } from 'lucide-react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

const STORAGE_KEY = 'gemini.apiKey';
const MODEL_KEY = 'genai.model';

export function BrainDumpApiKeySettings() {
    const [apiKey, setApiKey] = useState('');
    const [modelSelectValue, setModelSelectValue] = useState('gemini-2.5-flash');
    const [customModelInput, setCustomModelInput] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [saved, setSaved] = useState(false);
    const [hasExistingKey, setHasExistingKey] = useState(false);

    // Load from localStorage on mount
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const storedKey = localStorage.getItem(STORAGE_KEY) || '';
            const storedModel = localStorage.getItem(MODEL_KEY) || '';
            
            setApiKey(storedKey);
            setHasExistingKey(!!storedKey);

            const knownModels = ['gemini-2.5-pro', 'gemini-2.5-flash'];
            if (storedModel) {
                if (knownModels.includes(storedModel)) {
                    setModelSelectValue(storedModel);
                } else {
                    setModelSelectValue('custom');
                    setCustomModelInput(storedModel);
                }
            }
        }
    }, []);

    const handleSave = () => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(STORAGE_KEY, apiKey.trim());
            
            const finalModel = modelSelectValue === 'custom' ? customModelInput.trim() : modelSelectValue.trim();
            if (finalModel) {
                localStorage.setItem(MODEL_KEY, finalModel);
            }

            setHasExistingKey(!!apiKey.trim());
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        }
    };

    const handleClear = () => {
        if (typeof window !== 'undefined') {
            localStorage.removeItem(STORAGE_KEY);
            setApiKey('');
            setHasExistingKey(false);
        }
    };

    const isValidKeyFormat = apiKey.startsWith('AIza') && apiKey.length > 20;

    return (
        <Card className="bg-slate-900/50 border-slate-700">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                    <Key className="h-5 w-5 text-primary" />
                    Brain Dump API Key
                </CardTitle>
                <CardDescription className="text-slate-400">
                    Your Gemini API key for AI-powered task suggestions. Stored locally in your browser only — never sent to our servers.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Status Badge */}
                <div className="flex items-center gap-2">
                    {hasExistingKey ? (
                        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            API Key Configured
                        </Badge>
                    ) : (
                        <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                            <AlertCircle className="h-3 w-3 mr-1" />
                            No API Key Set
                        </Badge>
                    )}
                </div>

                {/* API Key Input */}
                <div className="space-y-2">
                    <Label htmlFor="api-key" className="text-slate-300">Gemini API Key</Label>
                    <div className="relative">
                        <Input
                            id="api-key"
                            type={showKey ? 'text' : 'password'}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="AIza..."
                            className="bg-slate-800 border-slate-700 pr-10"
                        />
                        <button
                            type="button"
                            onClick={() => setShowKey(!showKey)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                        >
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                    {apiKey && !isValidKeyFormat && (
                        <p className="text-xs text-amber-400">Key should start with &apos;AIza&apos; and be at least 20 characters</p>
                    )}
                </div>

                {/* Model Preference */}
                <div className="space-y-2 pt-2 border-t border-slate-800">
                    <Label className="text-slate-300 flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-primary" />
                        AI Model Preference
                    </Label>
                    <Select value={modelSelectValue} onValueChange={(v) => setModelSelectValue(v)}>
                        <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                            <SelectValue placeholder="Select a Gemini model" />
                        </SelectTrigger>
                        <SelectContent className="bg-slate-900 border-slate-700 text-white">
                            <SelectItem value="gemini-2.5-pro">gemini-2.5-pro</SelectItem>
                            <SelectItem value="gemini-2.5-flash">gemini-2.5-flash</SelectItem>
                            <SelectItem value="custom">Custom Model...</SelectItem>
                        </SelectContent>
                    </Select>

                    {modelSelectValue === 'custom' && (
                        <div className="mt-2 pt-2 border-t border-dashed border-slate-700 animate-in slide-in-from-top-2 duration-200">
                            <Label htmlFor="custom-model" className="text-[10px] text-amber-500 font-bold uppercase tracking-widest">Custom Model Name</Label>
                            <Input
                                id="custom-model"
                                placeholder="e.g. gemini-1.5-pro-002"
                                value={customModelInput}
                                onChange={(e) => setCustomModelInput(e.target.value)}
                                className="bg-slate-800 border-slate-700 mt-1 font-mono text-sm"
                            />
                            <p className="text-[10px] text-slate-500 mt-1 italic">
                                Enter a specific model ID (e.g. from experimental tiers).
                            </p>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                    <Button
                        onClick={handleSave}
                        disabled={!apiKey.trim() || saved}
                        className="bg-primary hover:bg-primary/90 text-black"
                    >
                        {saved ? (
                            <>
                                <CheckCircle className="h-4 w-4 mr-1" />
                                Saved!
                            </>
                        ) : (
                            <>
                                <Save className="h-4 w-4 mr-1" />
                                Save Key
                            </>
                        )}
                    </Button>
                    {hasExistingKey && (
                        <Button
                            variant="outline"
                            onClick={handleClear}
                            className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                        >
                            <Trash2 className="h-4 w-4 mr-1" />
                            Clear Key
                        </Button>
                    )}
                </div>

                {/* Help Text */}
                <div className="text-xs text-slate-500 space-y-1 pt-2 border-t border-slate-800">
                    <p className="flex items-center gap-1">
                        <Sparkles className="h-3 w-3" />
                        Get your free API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google AI Studio</a>
                    </p>
                    <p>• Key is stored only in your browser&apos;s localStorage</p>
                    <p>• Used for Brain Dump AI suggestions in task creation</p>
                    <p>• Clearing browser data will remove this key</p>
                </div>
            </CardContent>
        </Card>
    );
}

export default BrainDumpApiKeySettings;
