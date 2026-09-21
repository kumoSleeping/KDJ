//! FFmpeg owns the base pictures and record animation; KDJ supplies static masks
//! and one narrow, straight-alpha RGBA spectrum stream.
use anyhow::Result;
use kdj_core::audio_visualizer::{DiscMode, ImageTransform, Scene};
use std::path::Path;

fn n(value: f64) -> String {
    format!("{value:.9}")
}
fn loop_still(fps: u32) -> String {
    format!("loop=loop=-1:size=1:start=0,setpts=N/({fps}*TB)")
}

/// Crop before scaling/rotation to avoid enormous panorama intermediates. The
/// inverse-rotated viewport determines the crop margin, shared with Canvas.
fn fit(transform: &ImageTransform, width: u32, height: u32) -> String {
    let (cw, ch) = Scene::crop_extent(width as f64, height as f64, transform.rotation_deg);
    // Keep the exact ratio: rounded decimals can move floor(crop_height) by one pixel.
    let aspect = format!("({cw}/{ch})");
    let mut filters = vec!["format=rgba".to_string()];
    if transform.mirror_x {
        filters.push("hflip".into());
    }
    if transform.mirror_y {
        filters.push("vflip".into());
    }
    filters.push(format!("crop=w='max(1,floor(min(iw,ih*{aspect})/{}))':h='max(1,floor(min(ih,iw/{aspect})/{}))':x='floor((iw-ow)*{})':y='floor((ih-oh)*{})':exact=1", n(transform.zoom), n(transform.zoom), n(transform.focus_x), n(transform.focus_y)));
    filters.push(format!("scale={cw}:{ch}:flags=bicubic,format=rgba"));
    if transform.rotation_deg != 0. {
        let angle = n(transform.rotation_deg.to_radians());
        filters.push(format!(
            "rotate=a={angle}:ow='ceil(rotw({angle}))':oh='ceil(roth({angle}))':c=none"
        ));
    }
    filters.push(format!(
        "crop={width}:{height}:floor((iw-ow)/2):floor((ih-oh)/2):exact=1,setsar=1"
    ));
    if transform.blur > 0. {
        filters.push(format!("gblur=sigma={}", n(transform.blur)));
    }
    filters.join(",")
}

pub(super) fn disc_size(scene: &Scene) -> u32 {
    ((scene.canvas.width.min(scene.canvas.height) as f64 * scene.disc.size / 2.).round() as u32 * 2)
        .max(2)
}

pub(super) fn write_masks(scene: &Scene, stage: &Path) -> Result<()> {
    let c = &scene.canvas;
    write_pgm(&stage.join("arc.pgm"), c.width, c.height, |x, y| {
        ((x as f64 + 1. - scene.arc_x(y as f64 + 0.5)).clamp(0., 1.) * 255.).round() as u8
    })?;
    let size = disc_size(scene);
    write_pgm(&stage.join("disc.pgm"), size, size, |x, y| {
        let cx = x as f64 + 0.5 - size as f64 / 2.;
        let cy = y as f64 + 0.5 - size as f64 / 2.;
        ((size as f64 / 2. - 0.5 - (cx * cx + cy * cy).sqrt()).clamp(0., 1.) * 255.).round() as u8
    })
}
fn write_pgm(path: &Path, width: u32, height: u32, pixel: impl Fn(u32, u32) -> u8) -> Result<()> {
    use std::io::Write;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let mut file = std::io::BufWriter::new(file);
    write!(file, "P5\n{width} {height}\n255\n")?;
    let mut row = vec![0; width as usize];
    for y in 0..height {
        for x in 0..width {
            row[x as usize] = pixel(x, y);
        }
        file.write_all(&row)?;
    }
    file.flush()?;
    Ok(())
}

pub(super) fn required_filters(scene: &Scene) -> Vec<&'static str> {
    let mut filters = vec![
        "color",
        "format",
        "crop",
        "scale",
        "setsar",
        "loop",
        "setpts",
        "split",
        "alphaextract",
        "blend",
        "alphamerge",
        "overlay",
        "asetpts",
        "atrim",
        "setparams",
    ];
    if scene.disc.mode != DiscMode::Hidden
        || scene.left.rotation_deg != 0.
        || scene.right.rotation_deg != 0.
    {
        filters.push("rotate");
    }
    if scene.left.mirror_x || scene.right.mirror_x {
        filters.push("hflip");
    }
    if scene.left.mirror_y || scene.right.mirror_y {
        filters.push("vflip");
    }
    if scene.left.blur > 0. || scene.right.blur > 0. {
        filters.push("gblur");
    }
    filters
}

pub(super) fn build(scene: &Scene, audio: &Path, stage: &Path, duration: f64) -> Vec<String> {
    let c = &scene.canvas;
    let repeat = loop_still(c.fps);
    let (stripe_x, _, stripe_width, stripe_height) = scene.spectrum_rect();
    let size = disc_size(scene);
    let square = (size as f64 * 0.76).round() as u32;
    let still = ImageTransform::default();
    let mut graph = vec![
        format!(
            "color=c=black:s={}x{}:r={}:d={},format=rgba[black]",
            c.width,
            c.height,
            c.fps,
            n(duration)
        ),
        format!("[0:v]{}[leftstill]", fit(&scene.left, c.width, c.height)),
        format!("[leftstill]{repeat}[left]"),
        format!("[black][left]overlay=format=rgb:alpha=straight:shortest=1[base]"),
        format!(
            "[1:v]{},split=2[rightcolor][rightalpha]",
            fit(&scene.right, c.width, c.height)
        ),
        "[rightalpha]alphaextract[originalalpha]".into(),
        "[4:v]format=gray[arcmask]".into(),
        "[originalalpha][arcmask]blend=all_mode=multiply[rightmask]".into(),
        format!("[rightcolor][rightmask]alphamerge,{repeat}[right]"),
        "[base][right]overlay=format=rgb:alpha=straight:shortest=1[background]".into(),
    ];
    let mut previous = "background";
    if scene.disc.mode != DiscMode::Hidden {
        graph.extend([
            format!("[2:v]{},split=2[disccolor][discalpha]", fit(&still, size, size)),
            "[discalpha]alphaextract[discsourcealpha]".into(),
            "[5:v]format=gray[discmask]".into(),
            "[discsourcealpha][discmask]blend=all_mode=multiply[disccombinedalpha]".into(),
            format!("[disccolor][disccombinedalpha]alphamerge,{repeat},rotate=a='{}*t':ow=iw:oh=ih:c=none[disc]", n(scene.disc_angle(1.))),
            format!("[background][disc]overlay=x={}:y={}:format=rgb:alpha=straight:shortest=1[withdisc]", n(scene.disc.x * c.width as f64 - size as f64 / 2.), n(scene.disc.y * c.height as f64 - size as f64 / 2.)),
        ]);
        previous = "withdisc";
        if scene.disc.mode == DiscMode::Cover {
            graph.push(format!(
                "[3:v]{},{repeat}[square]",
                fit(&still, square, square)
            ));
            graph.push(format!("[withdisc][square]overlay=x={}:y={}:format=rgb:alpha=straight:shortest=1[withcover]", n(scene.disc.x * c.width as f64 - size as f64 * 0.78), n(scene.disc.y * c.height as f64 - square as f64 / 2.)));
            previous = "withcover";
        }
    }
    graph.push(format!(
        "[7:v]format=rgba,setpts=N/({}*TB)[spectrum]",
        c.fps
    ));
    graph.push(format!("[{previous}][spectrum]overlay=x={stripe_x}:y=0:format=rgb:alpha=straight:shortest=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]"));
    graph.push(format!(
        "[6:a:0]asetpts=PTS-STARTPTS,atrim=duration={}[aout]",
        n(duration)
    ));
    let mut args = [
        "-nostdin",
        "-n",
        "-v",
        "error",
        "-nostats",
        "-filter_complex_threads",
        "2",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.2",
    ]
    .map(str::to_string)
    .to_vec();
    // Static inputs are decoded once; loop filters cache only the transformed frame.
    let assets = [
        scene.images[scene.left.image].clone(),
        scene.images[scene.right.image].clone(),
        scene.images[scene.disc.image].clone(),
        scene.images[scene.disc.image].clone(),
        stage.join("arc.pgm").to_string_lossy().into_owned(),
        stage.join("disc.pgm").to_string_lossy().into_owned(),
    ];
    for asset in assets {
        args.extend([
            "-threads".into(),
            "1".into(),
            "-framerate".into(),
            c.fps.to_string(),
            "-i".into(),
            asset,
        ]);
    }
    args.extend([
        "-threads".into(),
        "1".into(),
        "-i".into(),
        audio.to_string_lossy().into_owned(),
    ]);
    args.extend([
        "-f".into(),
        "rawvideo".into(),
        "-pixel_format".into(),
        "rgba".into(),
        "-video_size".into(),
        format!("{stripe_width}x{stripe_height}"),
        "-framerate".into(),
        c.fps.to_string(),
        "-i".into(),
        "pipe:0".into(),
    ]);
    args.extend([
        "-filter_complex".into(),
        graph.join(";"),
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        "[aout]".into(),
        "-map_metadata".into(),
        "-1".into(),
        "-map_chapters".into(),
        "-1".into(),
        "-c:v:0".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "20".into(),
        "-threads:v:0".into(),
        "2".into(),
        "-pix_fmt:v:0".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "256k".into(),
        "-t".into(),
        n(duration),
        "-movflags".into(),
        "+faststart".into(),
        stage.join("render.mp4").to_string_lossy().into_owned(),
    ]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn graph_preserves_source_alpha_and_never_uses_chroma_key() {
        let scene = Scene::with_image(
            std::env::temp_dir()
                .join("封面 ' [1].png")
                .to_string_lossy()
                .into(),
        );
        let args = build(&scene, Path::new("audio.wav"), Path::new("stage"), 1.);
        let filter = &args[args.iter().position(|s| s == "-filter_complex").unwrap() + 1];
        assert!(filter.contains("alphaextract"));
        assert!(filter.contains("blend=all_mode=multiply"));
        assert!(!filter.contains("chromakey") && !filter.contains("colorkey"));
        assert!(!filter.contains("封面")); // Paths are argv values, never filter expressions.
        assert_eq!(
            args.windows(2)
                .filter(|p| p[0] == "-i" && p[1] == "pipe:0")
                .count(),
            1
        );
        assert!(!args.iter().any(|s| s == "-y"));
    }
}
