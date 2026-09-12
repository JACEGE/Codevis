import { useEffect, useRef, useState } from 'react';
import { buildDebugSequence } from '../pathfinder/treeModel';

/** Owns the Pathfinder state machine: tree + traversal mode -> visible step. */
export default function usePathfinder({ replaceActiveLinks }) {
    const [debugPath, setDebugPath] = useState([]);
    const [debugSequence, setDebugSequence] = useState([]);
    const [debugStep, setDebugStep] = useState(0);
    const [debugBranches, setDebugBranches] = useState([]);
    const [callStack, setCallStack] = useState([]);
    const [dfsTree, setDfsTree] = useState(null);
    const dfsTreeRef = useRef(null);
    const [sequentialMode, setSequentialMode] = useState(false);
    const [traceDirection, setTraceDirection] = useState('out');

    useEffect(() => {
        if (!dfsTree) {
            setDebugSequence([]);
            return;
        }
        setDebugSequence(buildDebugSequence(dfsTree, sequentialMode, traceDirection));
        setDebugStep(0);
    }, [sequentialMode, dfsTree, traceDirection]);

    useEffect(() => {
        if (debugSequence.length === 0 || debugStep < 0 || debugStep >= debugSequence.length) return;
        const state = debugSequence[debugStep];
        setCallStack(state.callStack);
        setDebugPath(state.debugPath);
        setDebugBranches(state.debugBranches);
        replaceActiveLinks(state.debugEdges);
    }, [debugSequence, debugStep, replaceActiveLinks]);

    return {
        callStack, debugBranches, debugPath, debugSequence, debugStep,
        dfsTreeRef, sequentialMode, traceDirection,
        setCallStack, setDebugBranches, setDebugPath, setDebugStep,
        setDfsTree, setSequentialMode, setTraceDirection,
    };
}
