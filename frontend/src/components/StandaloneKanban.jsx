import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import BRIDGE_URL from '../bridgeUrl';
import KanbanBoard from './KanbanBoard';

export default function StandaloneKanban() {
    const [socket, setSocket] = useState(null);
    const [db, setDb] = useState('project_db');
    useEffect(() => {
        const connection = io(BRIDGE_URL);
        connection.on('config:status', config => { if (config.activeDb) setDb(config.activeDb); });
        setSocket(connection);
        return () => { connection.disconnect(); };
    }, []);
    return <KanbanBoard db={db} socket={socket} />;
}
