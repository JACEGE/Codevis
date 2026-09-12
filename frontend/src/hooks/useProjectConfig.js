import { useEffect, useRef, useState } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';

export default function useProjectConfig({ activeDb }) {
    const [dashboard, setDashboard] = useState(null);
    const [projectRoot, setProjectRoot] = useState(null);
    const [webShellEnabled, setWebShellEnabled] = useState(false);
    const [extractors, setExtractors] = useState(null);
    const dashboardRef = useRef(null);

    useEffect(() => { dashboardRef.current = dashboard; }, [dashboard]);

    useEffect(() => {
        let active = true;
        requestJson(`${BRIDGE_URL}/api/status`)
            .then((config) => {
                if (!active || !config) return;
                setExtractors(config.extractors || {});
                setProjectRoot(config.projectRoot || null);
                setWebShellEnabled(config.webShellEnabled === true);
                if (config.dashboard) setDashboard(config.dashboard);
                // Workspace identity belongs to the live config and guarded
                // scope status flow, not this potentially late bootstrap read.
            })
            .catch(() => { /* bridge is optional during the first render */ });
        return () => { active = false; };
    }, [activeDb]);

    return { dashboard, dashboardRef, extractors, projectRoot, webShellEnabled };
}
