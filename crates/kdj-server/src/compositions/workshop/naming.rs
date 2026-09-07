use super::*;

fn filename(title: &str) -> String {
    title
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '/' => '／',
            '\\' => '＼',
            _ => c,
        })
        .collect()
}

fn automatic(project: &CompositionProject, name: &str) -> bool {
    let name = name.trim();
    name.is_empty()
        || name == "作品"
        || name
            .strip_prefix("任务 ")
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        || project
            .sources
            .iter()
            .any(|s| name == s.title.trim() || name == filename(&s.title))
}

/// Follow the same music used for video alignment. Explicitly edited names stay
/// editable; old task/video defaults and new material defaults follow the music.
pub(super) fn sync_music_names(project: &mut CompositionProject, previous: &CompositionProject) {
    let Some(title) = project
        .music_reference()
        .and_then(|c| project.source(&c.source_id))
        .map(|s| s.title.trim().to_owned())
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    if project.name == previous.name && automatic(previous, &previous.name) {
        project.name = title.clone();
    }
    if project.output.name == previous.output.name && automatic(previous, &previous.output.name) {
        project.output.name = filename(&title);
    }
}

#[cfg(test)]
pub(super) fn music_project() -> CompositionProject {
    let mut p = empty_project("任务 1", "/tmp");
    for (id, title, video) in [("v", "原视频", true), ("a", "音乐 / remix", false)] {
        let source = Source {
            kind: String::new(), frame_ends_ms: vec![],
            id: id.into(),
            track_id: 1,
            path: format!("/tmp/{id}"),
            title: title.into(),
            duration_ms: 90000.,
            video,
            audio: true,
            width: 1920,
            height: 1080,
            fps: 30.,
            signature: String::new(),
        };
        let mut clip = new_clip(&source, 0.);
        clip.id = format!("clip-{id}");
        p.layers.push(Layer {
            grid: None,
            id: id.into(),
            source_id: id.into(),
            clips: vec![clip],
        });
        p.sources.push(source);
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn music_names_replace_task_and_video_defaults_and_follow_replacement() {
        for old_name in ["任务 1", "原视频"] {
            let mut p = music_project();
            p.name = old_name.into();
            p.output.name = old_name.into();
            let old = p.clone();
            sync_music_names(&mut p, &old);
            assert_eq!(p.name, "音乐 / remix");
            assert_eq!(p.output.name, "音乐 ／ remix");
            let old = p.clone();
            p.sources[1].title = "替换音乐".into();
            sync_music_names(&mut p, &old);
            assert_eq!(p.name, "替换音乐");
            assert_eq!(p.output.name, "替换音乐");
        }
    }
    #[test]
    fn explicit_names_and_video_only_projects_remain_editable() {
        let mut p = music_project();
        let old = p.clone();
        p.name = "我的剪辑".into();
        p.output.name = "最终版本".into();
        sync_music_names(&mut p, &old);
        assert_eq!(p.name, "我的剪辑");
        assert_eq!(p.output.name, "最终版本");
        let old = p.clone();
        sync_music_names(&mut p, &old);
        assert_eq!(p.name, "我的剪辑");
        assert_eq!(p.output.name, "最终版本");
        p.layers.retain(|l| l.source_id == "v");
        p.name = "任务 2".into();
        p.output.name = "任务 2".into();
        let old = p.clone();
        sync_music_names(&mut p, &old);
        assert_eq!(p.name, "任务 2");
    }
    #[test]
    fn adding_music_to_an_empty_task_updates_both_names() {
        let old = empty_project("任务 1", "/tmp");
        let mut p = music_project();
        sync_music_names(&mut p, &old);
        assert_eq!(p.name, "音乐 / remix");
        assert_eq!(p.output.name, "音乐 ／ remix");
    }
}
