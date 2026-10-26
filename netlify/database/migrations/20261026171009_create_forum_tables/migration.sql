CREATE TABLE "posts" (
	"thread_id" integer,
	"id" integer,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"reply_to" integer,
	"reactions" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_pkey" PRIMARY KEY("thread_id","id")
);
--> statement-breakpoint
CREATE TABLE "profile_comments" (
	"id" serial PRIMARY KEY,
	"target" text NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY,
	"nick" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"nick" text PRIMARY KEY,
	"password_hash" text NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"title_color" text DEFAULT '#ffffff' NOT NULL,
	"avatar" text DEFAULT '' NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_thread_id_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_comments" ADD CONSTRAINT "profile_comments_target_users_nick_fkey" FOREIGN KEY ("target") REFERENCES "users"("nick") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_comments" ADD CONSTRAINT "profile_comments_author_users_nick_fkey" FOREIGN KEY ("author") REFERENCES "users"("nick") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nick_users_nick_fkey" FOREIGN KEY ("nick") REFERENCES "users"("nick") ON DELETE CASCADE ON UPDATE CASCADE;