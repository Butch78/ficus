//! The scorer's HTTP face, for the `ScorerContainer` Durable Object:
//! `GET /health` and `POST /score` (a `ScoreRequest`, answered with a
//! `ScoreReport`).

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use ficus_core::scoring::{ScoreReport, ScoreRequest};

async fn score(
    Json(request): Json<ScoreRequest>,
) -> Result<Json<ScoreReport>, (StatusCode, String)> {
    match ficus_scorer::score(&request).await {
        Ok(report) => Ok(Json(report)),
        Err(error) if error.is_input_problem() => {
            Err((StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))
        }
        Err(error) => {
            eprintln!("score {}: {error}", request.head.as_str());
            Err((StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
        }
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_owned());
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/score", post(score));
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    eprintln!("ficus-scorer listening on {port}");
    axum::serve(listener, app).await
}
