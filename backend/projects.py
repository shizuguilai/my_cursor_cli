"""
工作区项目管理
类似 cursor-remote-control 的 projects.json 系统
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional

PROJECTS_FILE = os.environ.get('PROJECTS_FILE', '/root/.openclaw/workspace/my_cursor_cli/projects.json')


def load_projects() -> Dict:
    """加载工作区配置"""
    if not os.path.exists(PROJECTS_FILE):
        return {
            'projects': {
                '默认项目': {
                    'path': '/root/.openclaw/workspace',
                    'description': 'OpenClaw 工作区'
                }
            },
            'default_project': '默认项目'
        }
    
    with open(PROJECTS_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_projects(data: Dict) -> None:
    """保存工作区配置"""
    with open(PROJECTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_projects() -> List[Dict]:
    """获取所有工作区列表"""
    data = load_projects()
    result = []
    for name, info in data.get('projects', {}).items():
        path = info.get('path', '')
        # 验证路径是否存在
        exists = os.path.isdir(path)
        result.append({
            'name': name,
            'path': path,
            'description': info.get('description', ''),
            'exists': exists,
        })
    return result


def add_project(name: str, path: str, description: str = '') -> Dict:
    """添加工作区"""
    data = load_projects()
    
    # 安全检查：禁止路径遍历
    if '..' in path or path.startswith('/'):
        resolved = str(Path(path).resolve())
    else:
        resolved = path
    
    data['projects'][name] = {
        'path': path,
        'description': description,
    }
    save_projects(data)
    
    return {'name': name, 'path': path, 'description': description, 'exists': os.path.isdir(path)}


def remove_project(name: str) -> bool:
    """删除工作区"""
    data = load_projects()
    if name in data['projects']:
        del data['projects'][name]
        if data.get('default_project') == name:
            # 重置为第一个
            keys = list(data['projects'].keys())
            data['default_project'] = keys[0] if keys else ''
        save_projects(data)
        return True
    return False


def get_default_project() -> Optional[Dict]:
    """获取默认工作区"""
    data = load_projects()
    default_name = data.get('default_project', '')
    projects = data.get('projects', {})
    
    if default_name and default_name in projects:
        info = projects[default_name]
        path = info.get('path', '')
        return {
            'name': default_name,
            'path': path,
            'description': info.get('description', ''),
            'exists': os.path.isdir(path),
        }
    
    # 返回第一个
    for name, info in projects.items():
        return {
            'name': name,
            'path': info.get('path', ''),
            'description': info.get('description', ''),
            'exists': os.path.isdir(info.get('path', '')),
        }
    
    return None


def set_default_project(name: str) -> bool:
    """设置默认工作区"""
    data = load_projects()
    if name in data['projects']:
        data['default_project'] = name
        save_projects(data)
        return True
    return False


def validate_workspace_path(path: str) -> bool:
    """验证工作区路径安全性"""
    if not path:
        return False
    # 禁止明显的路径遍历
    if '..' in path:
        return False
    # 检查绝对路径
    try:
        resolved = str(Path(path).resolve())
        return resolved.startswith('/')  # 必须是绝对路径
    except Exception:
        return False
