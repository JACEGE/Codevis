import { join, resolve } from 'node:path';

/** Never inherit the calling workspace's database paths, pidfile or ports. */
export function demoEnvironment(project, inherited = process.env) {
    const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => {
        const name = key.toUpperCase();
        return !name.startsWith('LADYBUG_') && ![
            'CODEVIS_PROJECT_DIR', 'CODEVIS_DATA_DIR', 'CODEVIS_BRIDGE_PORT', 'CODEVIS_DEFAULT_DB',
        ].includes(name);
    }));
    const root = resolve(project);
    const data = join(root, '.codevis');
    return {
        ...env, CODEVIS_PROJECT_DIR: root, CODEVIS_DATA_DIR: data, CODEVIS_DEFAULT_DB: 'project_db',
        LADYBUG_META_PATH: join(data, 'ladybug-meta'),
        LADYBUG_TARGET_PATH: join(data, 'ladybug-target'),
        LADYBUG_PIDFILE: join(data, '.ladybug-daemon.pid'),
        LADYBUG_DAEMON_LOG: join(data, 'daemon.log'),
    };
}
